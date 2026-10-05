# DeepCompanion Local Workspace Server

Python FastAPI 本地服务，为扩展提供工作区 Agent 工具（read / list / write / edit / bash）的真实执行能力。

## 启动

```bash
cd local-server
pip install fastapi uvicorn          # 依赖：fastapi + uvicorn
python run.py                        # 默认 http://127.0.0.1:8765
python run.py --port 9000            # 自定义端口（需与扩展设置一致）
```

## 安全模型

- **仅监听 127.0.0.1**，不暴露到局域网；CORS 只允许 `chrome-extension://` 来源。
- **三级权限（服务端强制矩阵）**：
  | 权限 | read/list | write/edit | bash |
  |---|---|---|---|
  | `read_only` 仅可查看 | ✅ | ❌ | ❌ |
  | `workspace_write` 工作区内修改 | ✅ | ✅ | ❌ |
  | `full_access` 完全权限 | ✅ | ✅ | ✅ |
- **路径沙箱**：所有文件操作以请求中的 `workspace_root` 为根，realpath 解析后必须仍在根内；拒绝绝对路径、`..` 逃逸与符号链接逃逸。未知权限值一律降级为 `read_only`（fail-closed）。
- **限额**：读 ≤512KB、写 ≤1MB、列目录 ≤500 项、bash 默认 30s（上限 120s）、输出截断 256KB。

## API

- `GET /health` → `{ok, version:"1", server, pid}`
- `POST /tools/{name}`，body：

```json
{
  "workspace_root": "/absolute/path/to/workspace",
  "permission": "read_only | workspace_write | full_access",
  "arguments": { "...工具参数..." }
}
```

工具与参数：
- `workspace_read`：`{path, encoding?}`
- `workspace_list`：`{path?}`（默认工作区根）
- `workspace_write`：`{path, content, mode?: overwrite|append|create_new}`
- `workspace_edit`：`{path, old_str, new_str, replace_all?}`
- `workspace_bash`：`{command, timeout?}`

响应统一为 `{ok:true,data:...}` 或 `{ok:false,error:{code,message}}`。

## 测试

```bash
cd local-server
python -m unittest test_local_server -v   # 13 个用例：权限矩阵/沙箱/HTTP API
```
