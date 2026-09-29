# Evidence map

All MemberLink data here is synthetic. The example artifact [memberlink.lookup-member-balance@1.0.0.json](memberlink.lookup-member-balance@1.0.0.json) is an exact snapshot of the approved file in `../capabilities/`. Its `provenance.discoveryRunId` and `transcriptDigest` link it to the genuine LLM exchange below. The `1.1.0` sub-account post was added by a human after discovery and is identified as such in its provenance.

| What to inspect | Evidence |
|---|---|
| LLM discovery of the balance lookup | [transcript](runs/discovery-2026-09-23T17-08-35-658Z-7d00838a/transcript.json), [structured log](runs/discovery-2026-09-23T17-08-35-658Z-7d00838a/run.jsonl) |
| LLM discovery of the sub-account confirmation flow | [transcript](runs/discovery-2026-09-23T17-10-27-841Z-13843906/transcript.json), [structured log](runs/discovery-2026-09-23T17-10-27-841Z-13843906/run.jsonl) |
| Model-free balance replay with typed outputs | [result](runs/replay-2026-09-23T17-12-22-886Z-9c273f75/result.json), [log](runs/replay-2026-09-23T17-12-22-886Z-9c273f75/run.jsonl) |
| Expected `MEMBER_NOT_FOUND` outcome | [result](runs/replay-2026-09-23T17-12-38-456Z-02be006f/result.json), [log](runs/replay-2026-09-23T17-12-38-456Z-02be006f/run.jsonl) |
| Human handoff on the same live session | [result](runs/replay-2026-09-23T17-16-03-436Z-670f43ed/result.json), [log](runs/replay-2026-09-23T17-16-03-436Z-670f43ed/run.jsonl), [screenshot](runs/replay-2026-09-23T17-16-03-436Z-670f43ed/048-escalation-s11-click.png) |
| Application 500, after the failure-result fix | [result](runs/replay-2026-09-29T15-30-11-639Z-5727f0f0/result.json), [log](runs/replay-2026-09-29T15-30-11-639Z-5727f0f0/run.jsonl), [screenshot](runs/replay-2026-09-29T15-30-11-639Z-5727f0f0/030-app-error-s07-click.png), [frame snapshot](runs/replay-2026-09-29T15-30-11-639Z-5727f0f0/030-app-error-s07-click.html) |
| Bad input rejected before opening a browser | [result](runs/replay-2026-09-29T15-30-05-944Z-aab1e760/result.json), [log](runs/replay-2026-09-29T15-30-05-944Z-aab1e760/run.jsonl) |

Older runs remain in `runs/` as development and adversarial test evidence. Some pre-fix failures have a log and snapshot but no `result.json`; the two September 29 runs above demonstrate the corrected result persistence. Discovery transcripts contain model tool calls and screen observations; replay logs contain actions and checks without model turns. The listed historical `result.json` files contain absolute paths from the recording machine; follow the relative links in this index when browsing the public repository.
