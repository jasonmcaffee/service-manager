Let's introduce the concept of run profiles.

There are times when we want to run various services on different cuda devices, and choose not to run some services, etc.

We can consider the current set of services, auto start, env variables like cuda_device (port isn't needed), to be run_profile "Image first -  Comfy 5090, LLama.cpp 3090".

All services should always exist for every profile, but just have different on/off autostart and CUDA_DEVICE values.

On the main screen by port kill, there should be a dropdown that lets me switch between profiles.
There should be a + button next to it to add a new profile, which clones the current profile settings.
The service cards Edit should show the appropriate value for CUDA DEVICE.  If I change the CUDA device on service card, it should apply to the run profile.
If I edit the run script for the service, however, or the port, it should be globally applied and not be profile specific. (add ui indicators so we know which are global vs profile specific)

When I switch between run profiles, all services should be stopped, then the services for the selected profile that have auto start should be started.
