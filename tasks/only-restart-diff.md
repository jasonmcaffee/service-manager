
# requirements
## Only restart diff
When I switch between profiles, I only want to start stop services that are actually different.
e.g. if vllm is configured the same (autostart, port, cuda) between different profiles, don't stop it when i change profiles.
if llama.cpp has a different cuda device, then it should restart, etc.

## Attach Already Running
When running service manager, there are times we want to develop and it requires service restart.
When this happens, the service configs try running again, and get errors like EADDRESS ALREADY IN USE.
We want to keep our services running, but attach to existing ones when we start up.

## create service for all profiles
Verify that when a new service is created, it is created across all profiles, with the same config as the current/orig profile it was created in.

## UI
### Drag to reorder
I want to be able to drag the services around to reorder them, and to have that order saved so if i refresh the page, it's the same.

### Collapse/Expand service
I want a toggle to collapse/expand a service, and its state to be remembered.  