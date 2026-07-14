# vhs tape for the Corral demo GIF. Reproduce with:  vhs docs/assets/demo.tape
# https://github.com/charmbracelet/vhs
# This records the mock backend so the GIF needs no local llama.cpp or weights.
Output docs/assets/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 18
Set Theme "Github Dark"

Type "corral serve --backend mock --port 11435 &" Sleep 500ms Enter
Sleep 1500ms

Type "curl -s localhost:11435/v1/chat/completions -d '{\"model\":\"qwen\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' | jq ." Sleep 400ms Enter
Sleep 1500ms

Type "curl -s localhost:11435/v1/chat/completions -d '{\"model\":\"llama\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' | jq .model" Sleep 400ms Enter
Sleep 1500ms

Type "corral ps" Sleep 400ms Enter
Sleep 2000ms

Type "kill %1" Enter
Sleep 500ms
