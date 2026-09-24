import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator as PwLocator } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ControlDescriptor,
  FrameObservation,
  Observation,
  PerformableAction,
  PerformResult,
  ResolveResult,
  ResolvedTarget,
  Surface,
} from './types.js';
import type { Condition, ControlRole, Locator, LocatorStrategy, TextMatch } from '../artifact/schema.js';
import { inventoryScript, type RawControl } from './inventory.js';
import { originPrefixMatches } from '../policy/origins.js';

/**
 * The inventory function is serialised into the page as source. TypeScript
 * transpilers emit `keepNames` wrappers (`__name(fn, "fn")`) that do not exist
 * in a browser context, so the source is wrapped in an IIFE carrying a local
 * shim. Evaluating an expression rather than injecting a global keeps the
 * promise that observing a screen never mutates it.
 */
const INVENTORY_EXPR = `(() => { const __name = (fn) => fn; const __defProp = Object.defineProperty; return (${inventoryScript.toString()})(); })()`;

const CONTROL_ROLES = new Set<string>([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'heading',
  'cell',
  'row',
  'table',
  'listitem',
  'menuitem',
  'tab',
  'dialog',
  'region',
]);

export type WebSurfaceOptions = {
  headless: boolean;
  viewport: { width: number; height: number };
  /** Only these origins may ever be loaded. Enforced at the network layer too. */
  allowedOrigins: string[];
  /** Exposed so a human can attach to the same live session during handoff. */
  remoteDebuggingPort?: number;
};

/**
 * Playwright-backed web surface.
 *
 * Playwright was chosen over a screenshot+coordinates CUA loop for one reason:
 * this system's value is in the *replay* path, and coordinate replay is not
 * deterministic across window sizes, fonts and scroll positions. The perception
 * side still behaves like a computer-use agent — the model reads an
 * accessibility snapshot and a control inventory, not HTML — but the action
 * side commits to addressable controls, which is what makes a recording
 * re-runnable a month later.
 *
 * Framesets, not iframes, are the hostile case handled here: each frame is an
 * independent document, and `framePath` addresses them by frame `name`.
 */
export class WebSurface implements Surface {
  readonly kind = 'web' as const;

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private lastStatus: number | undefined;
  /**
   * Recent navigation statuses across ALL frames, not just the top document.
   * In a frameset the interesting 500 arrives in the content frame while the
   * top document sits at 200 from minutes ago, so a single "last status" on
   * the main frame would never see an application error.
   */
  private statusLog: Array<{ status: number; at: number }> = [];
  private scopeStartedAt = Date.now();
  /** ref -> where to find the control again, from the most recent observation. */
  private refs = new Map<string, { framePath: string[]; xpath: string }>();
  private dialogPolicy: 'dismiss' | 'accept' = 'dismiss';
  private dialogs: Array<{ message: string; answered: 'accepted' | 'dismissed' }> = [];

  private constructor(private readonly opts: WebSurfaceOptions) {}

  static async launch(opts: WebSurfaceOptions): Promise<WebSurface> {
    const s = new WebSurface(opts);
    const args: string[] = [];
    if (opts.remoteDebuggingPort) args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`);
    s.browser = await chromium.launch({ headless: opts.headless, args });
    try {
      await s.setUp(opts);
    } catch (e) {
      // Everything after chromium.launch can throw. Without this the browser
      // process outlives the failed run, because the caller only sees an error.
      await s.browser.close().catch(() => {});
      throw e;
    }
    return s;
  }

  private async setUp(opts: WebSurfaceOptions): Promise<void> {
    const s = this;
    s.context = await s.browser.newContext({ viewport: opts.viewport });

    // Network-level allowlist. The policy engine also checks navigations, but
    // enforcing here means a stray asset, redirect or injected script cannot
    // reach an origin the capability was never permitted to touch.
    await s.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      if (s.isAllowed(url)) return route.continue();
      return route.abort('blockedbyclient');
    });

    s.page = await s.context.newPage();
    // Without a handler Playwright dismisses dialogs silently, so a confirm()
    // in front of a submit turns into "the click did nothing" with no trace of
    // why. Recording the dialog is what makes that diagnosable.
    s.page.on('dialog', (d) => {
      const answered = s.dialogPolicy === 'accept' ? 'accepted' : 'dismissed';
      s.dialogs.push({ message: d.message(), answered });
      void (answered === 'accepted' ? d.accept() : d.dismiss()).catch(() => {});
    });
    s.page.on('response', (r) => {
      if (!r.request().isNavigationRequest()) return;
      s.lastStatus = r.status();
      s.statusLog.push({ status: r.status(), at: Date.now() });
      if (s.statusLog.length > 40) s.statusLog.shift();
    });
  }

  /** Exposed to the session controller so a human can drive the same page. */
  livePage(): Page {
    return this.page;
  }
  liveContext(): BrowserContext {
    return this.context;
  }

  isAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      return this.opts.allowedOrigins.some((o) => originPrefixMatches(u, o));
    } catch {
      return false;
    }
  }

  beginScope(): void {
    this.scopeStartedAt = Date.now();
    this.dialogs = [];
  }

  setDialogPolicy(policy: 'dismiss' | 'accept'): void {
    this.dialogPolicy = policy;
  }

  dialogsSeen(): Array<{ message: string; answered: 'accepted' | 'dismissed' }> {
    return [...this.dialogs];
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  /* ------------------------------- observe ------------------------------ */

  async observe(opts?: { screenshot?: boolean; screenshotPath?: string }): Promise<Observation> {
    const frames = this.page.frames();
    const frameObs: FrameObservation[] = [];
    const controls: ControlDescriptor[] = [];
    this.refs.clear();
    let n = 0;

    for (const f of frames) {
      const path = this.framePath(f);
      let aria = '';
      let text = '';
      let raw: RawControl[] = [];
      try {
        aria = await f.locator('body').ariaSnapshot({ timeout: 2000 });
      } catch {
        /* a frame can be mid-navigation; an empty snapshot is honest */
      }
      try {
        text = normalise(await f.locator('body').innerText({ timeout: 2000 }));
      } catch {
        /* ignore */
      }
      try {
        raw = (await f.evaluate(INVENTORY_EXPR)) as RawControl[];
      } catch {
        /* ignore */
      }

      frameObs.push({ framePath: path, url: f.url(), title: await safeTitle(f), ariaSnapshot: trim(aria, 4000), text: trim(text, 4000) });

      for (const rc of raw) {
        if (!rc.visible) continue;
        const role = (CONTROL_ROLES.has(rc.role) ? rc.role : 'button') as ControlRole;
        const ref = 'c' + ++n;
        this.refs.set(ref, { framePath: path, xpath: rc.xpath });
        controls.push({
          ref,
          role,
          name: rc.name,
          visualLabel: rc.visualLabel,
          fieldName: rc.fieldName,
          value: rc.value,
          enabled: rc.enabled,
          framePath: path,
          kind: rc.kind,
          candidateStrategies: rankStrategies(rc, role),
        });
      }
    }

    let screenshotPath: string | undefined;
    if (opts?.screenshot && opts.screenshotPath) {
      screenshotPath = await this.screenshot(opts.screenshotPath);
    }

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      httpStatus: this.lastStatus,
      frames: frameObs,
      controls,
      screenshotPath,
      capturedAt: new Date().toISOString(),
    };
  }

  private framePath(f: Frame): string[] {
    const path: string[] = [];
    let cur: Frame | null = f;
    while (cur && cur.parentFrame()) {
      path.unshift(cur.name() || '<unnamed>');
      cur = cur.parentFrame();
    }
    return path;
  }

  private frameAt(path: string[]): Frame | null {
    if (path.length === 0) return this.page.mainFrame();
    let cur: Frame = this.page.mainFrame();
    for (const seg of path) {
      const next: Frame | undefined = cur.childFrames().find((c) => c.name() === seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /* ------------------------------- resolve ------------------------------ */

  async resolveRef(ref: string): Promise<ResolveResult> {
    const rec = this.refs.get(ref);
    if (!rec) {
      return { ok: false, failure: { reason: 'not_found', attempts: [{ strategyIndex: 0, kind: 'ref', matched: 0, error: `unknown ref ${ref}` }] } };
    }
    const frame = this.frameAt(rec.framePath);
    if (!frame) return { ok: false, failure: { reason: 'frame_missing', attempts: [] } };
    const pw = frame.locator('xpath=' + rec.xpath);
    const count = await pw.count().catch(() => 0);
    if (count !== 1) {
      return { ok: false, failure: { reason: count === 0 ? 'not_found' : 'ambiguous', attempts: [{ strategyIndex: 0, kind: 'ref', matched: count }] } };
    }
    return { ok: true, target: { strategyIndex: 0, strategy: { kind: 'xpath', expression: rec.xpath, tier: 'fragile' }, handle: pw } };
  }

  /**
   * Try each strategy in order and stop at the first that resolves to exactly
   * one visible control.
   *
   * Ambiguity is treated as failure of that strategy, not as "take the first".
   * In a banking back office, acting on an arbitrary one of three matching
   * controls is worse than not acting at all, so a strategy that cannot
   * disambiguate is discarded in favour of one that can.
   */
  async resolve(locator: Locator, timeoutMs: number): Promise<ResolveResult> {
    // `framePath: ["*"]` means "wherever it is". App-level recovery rules need
    // this: a session-expiry screen or a maintenance notice can appear in the
    // top document or inside whichever frame happened to request it, and a
    // rule written once per application cannot know which.
    if (locator.framePath[0] === '*') return this.resolveAnyFrame(locator, timeoutMs);

    const frame = this.frameAt(locator.framePath);
    if (!frame) {
      return { ok: false, failure: { reason: 'frame_missing', attempts: [{ strategyIndex: -1, kind: 'frame', matched: 0, error: `frame ${locator.framePath.join('/')} not present` }] } };
    }
    const attempts: Array<{ strategyIndex: number; kind: string; matched: number; error?: string }> = [];
    const deadline = Date.now() + timeoutMs;

    // One pass per strategy, then retry the whole ranked list until the
    // deadline. Retrying the list (rather than waiting inside one strategy)
    // means a page that is still rendering does not permanently downgrade us to
    // a fragile fallback just because the semantic handle was 200ms late.
    while (true) {
      for (const [i, strategy] of locator.strategies.entries()) {
        let pw: PwLocator;
        try {
          pw = this.toPwLocator(frame, strategy);
        } catch (e) {
          attempts.push({ strategyIndex: i, kind: strategy.kind, matched: 0, error: (e as Error).message });
          continue;
        }
        let matched = 0;
        try {
          const all = await pw.all();
          const visible: PwLocator[] = [];
          for (const c of all) if (await c.isVisible().catch(() => false)) visible.push(c);
          matched = visible.length;
          if (matched === 1) {
            return { ok: true, target: { strategyIndex: i, strategy, handle: visible[0] as PwLocator } };
          }
        } catch (e) {
          attempts.push({ strategyIndex: i, kind: strategy.kind, matched: 0, error: (e as Error).message });
          continue;
        }
        attempts.push({ strategyIndex: i, kind: strategy.kind, matched });
      }
      if (Date.now() >= deadline) break;
      await sleep(150);
    }

    const anyAmbiguous = attempts.some((a) => a.matched > 1);
    return { ok: false, failure: { reason: anyAmbiguous ? 'ambiguous' : 'not_found', attempts: dedupeAttempts(attempts) } };
  }

  private async resolveAnyFrame(locator: Locator, timeoutMs: number): Promise<ResolveResult> {
    const deadline = Date.now() + timeoutMs;
    const attempts: Array<{ strategyIndex: number; kind: string; matched: number; error?: string }> = [];
    while (true) {
      for (const [i, strategy] of locator.strategies.entries()) {
        const hits: PwLocator[] = [];
        for (const f of this.page.frames()) {
          try {
            for (const c of await this.toPwLocator(f, strategy).all()) {
              if (await c.isVisible().catch(() => false)) hits.push(c);
            }
          } catch {
            /* frame mid-navigation */
          }
        }
        if (hits.length === 1) return { ok: true, target: { strategyIndex: i, strategy, handle: hits[0] as PwLocator } };
        attempts.push({ strategyIndex: i, kind: strategy.kind, matched: hits.length });
      }
      if (Date.now() >= deadline) break;
      await sleep(150);
    }
    const ambiguous = attempts.some((a) => a.matched > 1);
    return { ok: false, failure: { reason: ambiguous ? 'ambiguous' : 'not_found', attempts: dedupeAttempts(attempts) } };
  }

  private toPwLocator(frame: Frame, s: LocatorStrategy): PwLocator {
    switch (s.kind) {
      case 'role':
        return frame.getByRole(s.role as never, s.name ? { name: s.name, exact: s.match === 'exact' } : {});
      case 'label':
        return frame.getByLabel(s.text, { exact: s.match === 'exact' });
      case 'text':
        return frame.getByText(s.value, { exact: s.match === 'exact' });
      case 'fieldName':
        return frame.locator(`[name="${cssEscape(s.name)}"]`);
      case 'nearText': {
        const anchor = xpathTextPredicate(s.anchor, s.anchorMatch);
        const axis = s.direction === 'following' ? 'following' : 'preceding';
        const controlPred = controlXPathPredicate(s.control);
        return frame.locator(`xpath=(//*[${anchor}]/${axis}::*[${controlPred}])[${s.ordinal}]`);
      }
      case 'tableCell': {
        const rowPred = `td[contains(normalize-space(.), ${xpathLiteral(s.rowContains)})] or th[contains(normalize-space(.), ${xpathLiteral(s.rowContains)})]`;
        if (typeof s.column === 'number') {
          return frame.locator(`xpath=//tr[${rowPred}]/td[${s.column + 1}]`);
        }
        // Column addressed by header text: find its index, then take that cell.
        // The second predicate is load-bearing. `count()` of a header that does
        // not exist is 0, so without it the expression degrades to `td[1]` and
        // returns the FIRST column — one match, no error, wrong number. A
        // renamed column has to fail the strategy so the ranked list moves on,
        // not hand back a confidently wrong balance.
        const header = `ancestor::table[1]//tr[1]/th[normalize-space(.)=${xpathLiteral(s.column)}]`;
        return frame.locator(`xpath=//tr[${rowPred}]/td[count(${header}/preceding-sibling::th)+1][${header}]`);
      }
      case 'css':
        return frame.locator(s.selector);
      case 'xpath':
        return frame.locator('xpath=' + s.expression);
    }
  }

  /* ------------------------------- perform ------------------------------ */

  async perform(action: PerformableAction, timeoutMs: number): Promise<PerformResult> {
    try {
      switch (action.type) {
        case 'navigate': {
          if (!this.isAllowed(action.url)) return { ok: false, error: `navigation to ${action.url} is outside the allowlist` };
          const r = await this.page.goto(action.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
          this.lastStatus = r?.status() ?? this.lastStatus;
          await this.settle(timeoutMs);
          return { ok: true };
        }
        case 'click': {
          const pw = action.target.handle as PwLocator;
          await pw.click({ timeout: timeoutMs });
          await this.settle(timeoutMs);
          return { ok: true };
        }
        case 'fill': {
          const pw = action.target.handle as PwLocator;
          await pw.fill(action.value, { timeout: timeoutMs });
          return { ok: true };
        }
        case 'select': {
          const pw = action.target.handle as PwLocator;
          await pw.selectOption(action.value, { timeout: timeoutMs });
          return { ok: true };
        }
        case 'press': {
          if (action.target) await (action.target.handle as PwLocator).press(action.key, { timeout: timeoutMs });
          else await this.page.keyboard.press(action.key);
          await this.settle(timeoutMs);
          return { ok: true };
        }
        case 'readText': {
          const pw = action.target.handle as PwLocator;
          const t = await pw.innerText({ timeout: timeoutMs }).catch(async () => (await pw.inputValue({ timeout: timeoutMs }).catch(() => '')) || '');
          return { ok: true, text: normalise(t) };
        }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Settle, not sleep.
   *
   * Every wait in this system is bounded and tied to an observable condition.
   * Here that condition is "all frames reached domcontentloaded"; everywhere
   * else it is a declared checkpoint. There are no fixed sleeps in the replay
   * path, which is what keeps a slow tenant from being a flaky tenant.
   */
  private async settle(timeoutMs: number): Promise<void> {
    const budget = Math.min(timeoutMs, 10_000);
    await this.page.waitForLoadState('domcontentloaded', { timeout: budget }).catch(() => {});
    await Promise.all(
      this.page.frames().map((f) => f.waitForLoadState('domcontentloaded', { timeout: budget }).catch(() => {})),
    );
  }

  /* ------------------------------ conditions ---------------------------- */

  async evaluate(condition: Condition, timeoutMs: number): Promise<{ held: boolean; detail: string }> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (true) {
      const r = await this.evaluateOnce(condition);
      if (r.held) return r;
      last = r.detail;
      if (Date.now() >= deadline) return { held: false, detail: last };
      await sleep(150);
    }
  }

  private async evaluateOnce(c: Condition): Promise<{ held: boolean; detail: string }> {
    switch (c.kind) {
      case 'urlMatches': {
        const urls = [this.page.url(), ...this.page.frames().map((f) => f.url())];
        const hit = urls.some((u) => matches(u, c.pattern, c.match ?? 'contains'));
        return { held: hit, detail: hit ? `url matched ${c.pattern}` : `no frame url matched ${c.pattern} (saw ${urls.join(' , ')})` };
      }
      case 'textPresent':
      case 'textAbsent': {
        const frames = c.framePath ? [this.frameAt(c.framePath)].filter(Boolean) : this.page.frames();
        let found = false;
        for (const f of frames as Frame[]) {
          const t = await f
            .locator('body')
            .innerText({ timeout: 1500 })
            .catch(() => '');
          if (matches(normalise(t), c.value, c.match ?? 'contains')) {
            found = true;
            break;
          }
        }
        const want = c.kind === 'textPresent';
        return { held: found === want, detail: `text ${JSON.stringify(c.value)} ${found ? 'present' : 'absent'}` };
      }
      case 'visible':
      case 'notVisible': {
        const r = await this.resolve(c.locator, 0);
        const vis = r.ok;
        const want = c.kind === 'visible';
        return { held: vis === want, detail: `${c.locator.description} ${vis ? 'visible' : 'not visible'}` };
      }
      case 'count': {
        const frame = this.frameAt(c.locator.framePath);
        if (!frame) return { held: false, detail: 'frame missing' };
        let total = 0;
        for (const s of c.locator.strategies) {
          try {
            total = Math.max(total, await this.toPwLocator(frame, s).count());
          } catch {
            /* ignore */
          }
        }
        const okMin = c.min === undefined || total >= c.min;
        const okMax = c.max === undefined || total <= c.max;
        return { held: okMin && okMax, detail: `${c.locator.description} count=${total}` };
      }
      case 'httpStatusAtLeast': {
        // Scoped to the current step: "the application errored while doing
        // this", not "at some point during this run".
        const hit = this.statusLog.filter((x) => x.at >= this.scopeStartedAt).find((x) => x.status >= c.status);
        return { held: Boolean(hit), detail: hit ? `navigation returned http ${hit.status}` : `no navigation returned >= ${c.status} recently` };
      }
      case 'all': {
        const parts = await Promise.all(c.of.map((x) => this.evaluateOnce(x)));
        const held = parts.every((p) => p.held);
        return { held, detail: parts.map((p) => p.detail).join(' AND ') };
      }
      case 'any': {
        const parts = await Promise.all(c.of.map((x) => this.evaluateOnce(x)));
        const held = parts.some((p) => p.held);
        return { held, detail: parts.map((p) => p.detail).join(' OR ') };
      }
      case 'not': {
        const p = await this.evaluateOnce(c.of);
        return { held: !p.held, detail: `NOT (${p.detail})` };
      }
    }
  }

  /* ------------------------------ evidence ------------------------------ */

  async screenshot(path: string): Promise<string | undefined> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      await this.page.screenshot({ path, fullPage: false, timeout: 8000 });
      return path;
    } catch {
      return undefined;
    }
  }

  async snapshot(path: string): Promise<string | undefined> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const parts: string[] = [];
      for (const f of this.page.frames()) {
        const html = await f.content().catch(() => '<!-- unavailable -->');
        parts.push(`<!-- frame: ${this.framePath(f).join('/') || '<top>'} url=${f.url()} -->\n${html}`);
      }
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, parts.join('\n\n<!-- ======== -->\n\n'), 'utf8');
      return path;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

/* --------------------------- strategy ranking --------------------------- */

/**
 * Turn one observed control into a ranked list of ways to find it again.
 *
 * Ordering is the robustness argument made executable: accessibility-tree
 * handles first because they survive restyling and port to desktop, then
 * structural handles that legacy apps do have (the visual label, the form field
 * name), then position, then a raw XPath that exists only so that a capability
 * is never unrecordable.
 */
export function rankStrategies(rc: RawControl, role: ControlRole): LocatorStrategy[] {
  const out: LocatorStrategy[] = [];

  // Read-only value cells have a different set of available handles: they are
  // never named, so the useful ones are "the cell after the label" and "the
  // cell at the intersection of this row and this column".
  if (rc.kind === 'value') {
    if (rc.visualLabel) {
      out.push({
        kind: 'nearText',
        anchor: rc.visualLabel + ':',
        anchorMatch: 'exact',
        direction: 'following',
        control: 'cell',
        ordinal: 1,
        tier: 'structural',
      });
    }
    if (rc.rowKey && rc.columnHeader) {
      out.push({ kind: 'tableCell', rowContains: rc.rowKey, column: rc.columnHeader, tier: 'positional' });
    }
    if (rc.rowKey && rc.columnIndex !== undefined) {
      out.push({ kind: 'tableCell', rowContains: rc.rowKey, column: rc.columnIndex, tier: 'positional' });
    }
    out.push({ kind: 'xpath', expression: rc.xpath, tier: 'fragile' });
    return out;
  }

  if (rc.name) out.push({ kind: 'role', role, name: rc.name, match: 'exact', tier: 'semantic' });
  if (rc.labelFor) out.push({ kind: 'label', text: rc.labelFor.replace(/[:：]\s*$/, ''), match: 'exact', tier: 'semantic' });

  if (rc.visualLabel && rc.visualLabel !== rc.name) {
    out.push({
      kind: 'nearText',
      anchor: rc.visualLabel + ':',
      anchorMatch: 'exact',
      direction: 'following',
      control: role,
      ordinal: 1,
      tier: 'structural',
    });
    out.push({
      kind: 'nearText',
      anchor: rc.visualLabel,
      anchorMatch: 'contains',
      direction: 'following',
      control: role,
      ordinal: 1,
      tier: 'structural',
    });
  }

  if (rc.fieldName) out.push({ kind: 'fieldName', name: rc.fieldName, tier: 'structural' });

  if (rc.rowKey && rc.columnIndex !== undefined) {
    out.push({ kind: 'tableCell', rowContains: rc.rowKey, column: rc.columnIndex, tier: 'positional' });
  }

  out.push({ kind: 'xpath', expression: rc.xpath, tier: 'fragile' });
  return out;
}

/* ------------------------------- helpers -------------------------------- */

function controlXPathPredicate(role?: ControlRole): string {
  switch (role) {
    case 'textbox':
      return "self::input[not(@type) or @type='text' or @type='password' or @type='number' or @type='tel' or @type='email'] or self::textarea";
    case 'combobox':
      return 'self::select';
    case 'button':
      return "self::button or self::input[@type='submit' or @type='button' or @type='reset']";
    case 'link':
      return 'self::a[@href]';
    case 'checkbox':
      return "self::input[@type='checkbox']";
    case 'radio':
      return "self::input[@type='radio']";
    case 'cell':
      return 'self::td or self::th';
    default:
      return 'self::input or self::select or self::textarea or self::button or self::a';
  }
}

function xpathTextPredicate(anchor: string, match: TextMatch): string {
  const lit = xpathLiteral(anchor);
  return match === 'exact' ? `normalize-space(text())=${lit}` : `contains(normalize-space(text()), ${lit})`;
}

/** XPath has no escape character; the only portable approach is concat(). */
function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return 'concat(' + s.split("'").map((p) => `'${p}'`).join(`, "'", `) + ')';
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

export function matches(haystack: string, needle: string, match: TextMatch): boolean {
  if (match === 'exact') return haystack.trim() === needle.trim();
  if (match === 'regex') return new RegExp(needle, 'i').test(haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function normalise(s: string): string {
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function trim(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… [${s.length - n} more chars]`;
}

async function safeTitle(f: Frame): Promise<string> {
  try {
    return await f.title();
  } catch {
    return '';
  }
}

function dedupeAttempts<T extends { strategyIndex: number; kind: string }>(xs: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x.strategyIndex)) continue;
    seen.add(x.strategyIndex);
    out.push(x);
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
