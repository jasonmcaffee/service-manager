
# Requirements
## Service Layered Architecture
Let's refactor our code and clean things up.

Routes/controllers should only abstract http details.
Work should be forwarded down to services layer.

- lib
  - services
  - repositories
  - util

## Verify functionality
We only want to boot services when the service is first started.
Ensure we aren't starting anything because of a page load or page reload.

I see ComfyUI start when I reload the page.  I don't want that.

## Stop Should actually Stop
In some cases where there is an auto-start, and then i click stop, i still see the process running, and the logs show up.
We want to ensure that stop actually stops the process.

## Port
One way we can ensure that things work correctly and stop correctly is to have a PORT variable.
Services like comfyui, llama.cpp, etc have a Port that we can pass.
Let's add a UI element for that, and store it in the db.
In the startup script, make it available as an env variable.


e.g. behind the scenes, we should do something like:
set PORT=8080

then in the script I can do:
e.g.
.\prebuilt-download\llama-server.exe -m C:\shared-drive\llm_models\qwen-3.6\unsloth-Qwen3.6-35B-A3B-GGUF-Qwen3.6-35B-A3B-UD-Q4_K_M.gguf -ngl 9999 --host 0.0.0.0 --port %PORT% -dev cuda1 --mmproj "C:\shared-drive\llm_models\qwen-3.6\unsloth-Qwen3.6-35B-A3B-GGUF-mmproj-BF16.gguf" -c 100000

Then, when power button is pressed to turn off, we can also verify that the port is no longer listened to and kill that way if needed.

