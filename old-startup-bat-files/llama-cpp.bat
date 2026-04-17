REM cd c:\jason\dev\llama.cpp-v3\build
REM .\bin\Release\llama-server.exe -m C:\shared-drive\llm_models\Unsloth-Qwen3-32B-Q4_K_M.gguf -ngl 9999 --host 0.0.0.0  --jinja --min_p 0.0 --top_p 0.8 --flash-attn on -dev cuda1 --chat-template-file C:\jason\dev\ai-service\src\utils\fixed-tool-call-template.txt

cd c:\jason\dev\llama.cpp-v3
.\prebuilt-download\llama-server.exe -m C:\shared-drive\llm_models\unsloth-Qwen3-VL-30B-A3B-Instruct-GGUF-Qwen3-VL-30B-A3B-Instruct-Q4_K_M.gguf -ngl 9999 --host 0.0.0.0 -dev cuda1 --mmproj "C:\shared-drive\llm_models\mmproj-Qwen3VL-30B-A3B-Instruct-F16.gguf"
