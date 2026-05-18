# Status Change
When one service changes, starts, is saved, etc. the whole page refreshes.
We only want to update ui elements that need updating (e.g. we don't want to see logs etc repaint)

# logs
When we reattach, we see a bunch of logs in the service logs, like this for AI Service:
[Adopted external windows process pid=159348 at 2026-05-12T22:38:26.268Z]
[Adopted external windows process pid=159348 at 2026-05-12T22:38:26.430Z]
[Adopted external windows process pid=159348 at 2026-05-12T22:38:29.786Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:46:46.018Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:46:52.638Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:48:19.208Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:52:30.365Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:52:35.224Z]
[Adopted external windows process pid=159348 at 2026-05-12T23:53:04.600Z]

Why are we seeing all that? 

