when the service-manager first starts, it looks like vllm is not running (looking at vllm ui), but the process is indeed running (gpu vram is filled with the model).

Look into the issue by stopping all services, restarting the service-manager, and using playwright to evaluate the ui.
Ensure all services that should be auto-start are shown, and if there happens to be errors, ensure the error logs are displayed.


Also, there are times when I edit a service, power on a service, and the entire page appears to refresh.
We only want to see ui updates for things that were impacted by the change.

Investigate the issue by testing to recreate the issues first, then fix, then confirm.
Feel free to start/stop any service