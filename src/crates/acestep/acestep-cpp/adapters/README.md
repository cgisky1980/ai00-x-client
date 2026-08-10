# Adapters

Place your adapter files or folders here. Three trainer formats are supported,
auto detected from the safetensors payload.

| Trainer | Layout                | Alpha source                          | Example                                |
|---------|-----------------------|---------------------------------------|----------------------------------------|
| PEFT    | folder                | `lora_alpha` in `adapter_config.json` | `ACE-Step-v1.5-chinese-new-year-LoRA/` |
| ComfyUI | single `.safetensors` | per tensor `.alpha` scalar            | `turbo_v9_1850_comfyui.safetensors`    |
| LyCORIS | single `.safetensors` | per module `.alpha` scalar            | `acestep-qinglong-lokr.safetensors`    |

LyCORIS LoKr handles factorized (`lokr_w2_a` + `lokr_w2_b`) or monolithic
(`lokr_w2`) weights, with optional DoRA via `dora_scale`.

Point the server at this folder:

```bash
./build/ace-server --models ./models --adapters ./adapters
```
