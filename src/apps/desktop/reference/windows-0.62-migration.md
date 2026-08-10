# Windows 0.62.x API 迁移记录

## 背景

从 `windows` crate 0.61.3 升级到 0.62.2，因为 `web-rwkv` 依赖的 `wgpu-hal` 29.0.1 需要 `windows 0.62.2`。

## 核心破坏性变更

`windows` crate 0.62.0 进行了重大架构重构，将原来内嵌的集合类型和异步类型拆分到了独立的 crate 中。

### 类型映射表

| 0.61.3 类型 | 0.62.2 类型 | 所属 crate |
|---|---|---|
| `windows::Foundation::IAsyncOperation<T>` | `windows_future::IAsyncOperation<T>` | `windows-future` |
| `windows::Foundation::IAsyncAction` | `windows_future::IAsyncAction` | `windows-future` |
| `windows::Media::Ocr::OcrLineCollection` | `windows_collections::IVectorView<OcrLine>` | `windows-collections` |
| `windows::Media::Ocr::OcrWordCollection` | `windows_collections::IVectorView<OcrWord>` | `windows-collections` |
| `windows::Foundation::Collections::IVectorView<T>` | `windows_collections::IVectorView<T>` | `windows-collections` |
| `windows::Foundation::Collections::IVector<T>` | `windows_collections::IVector<T>` | `windows-collections` |
| `windows::Foundation::Collections::IMap<K,V>` | `windows_collections::IMap<K,V>` | `windows-collections` |
| `windows_core::BSTR` | `windows::core::BSTR` | `windows` |

### Cargo.toml 变更

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62.2", features = [...] }
windows-future = "0.3.2"
windows-collections = "0.3.2"
```

### 异步操作等待方式

0.61.3:
```rust
let result = w(async_op?.get())?;
```

0.62.2:
```rust
// 方式1: 使用 windows_future 的 .join() 方法（同步等待）
fn block_on_async<T: windows::core::RuntimeType>(
    async_op: windows::core::Result<windows_future::IAsyncOperation<T>>,
) -> Ai00XResult<T> {
    let op = w(async_op)?;
    op.join()
        .map_err(|e| Ai00XError::tool(format!("Windows OCR async: {}", e)))
}
```

### Cargo.lock 重新生成

删除旧的 Cargo.lock 并重新生成，确保 `gpu-allocator` 等依赖解析到 `windows 0.62.2`。

## 日期

2026-04-18
