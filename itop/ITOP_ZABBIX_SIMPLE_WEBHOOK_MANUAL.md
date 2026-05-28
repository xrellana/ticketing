# Zabbix iTop Simple Webhook 使用手册

本文档只适用于 `itop/zbx_itop_simple.js`。

如果使用完整脚本 `itop/zbx_itop.js`，请看 `ITOP_ZABBIX_WEBHOOK_MANUAL.md`。完整手册里的很多参数在 simple 脚本中不会被读取，照完整手册配置会显得很复杂，也可能让人误以为支持工单更新、自定义 JSON 字段、tag 覆盖优先级等能力。

## 1. simple 版本做什么

`zbx_itop_simple.js` 只做三件事：

1. Zabbix problem 事件创建 iTop 工单。
2. 创建成功后把 iTop 工单 ID、单号、链接写回 Zabbix event tags。
3. Zabbix recovery 事件根据写回的 ID 执行 `ev_resolve`，然后执行 `ev_close`。

可选能力：

- 创建时写入 caller、origin、service、service subcategory、request type。
- 创建成功后用 `ev_assign` 分派给 team / agent。
- 按 Zabbix severity 写入固定映射的 iTop `impact` / `urgency`。

不支持的能力：

- 不处理 Zabbix problem update。
- 不追加问题更新日志。
- 不支持 `event_tags_json`。
- 不支持从 trigger tags 读取 team / agent。
- 不支持 `itop_create_fields_json`、`itop_update_fields_json`、`itop_recovery_fields_json`。
- 不支持通过参数覆盖 severity mapping。
- 不支持 `itop_auto_close` 开关。只要 recovery 通知调用了脚本，就会尝试 resolve + close。

## 2. iTop 前提

iTop REST 账号需要：

- 能访问 REST API。
- 能创建目标工单类，例如 `UserRequest` 或 `Incident`。
- 能执行目标类生命周期动作 `ev_assign`、`ev_resolve`、`ev_close`。

脚本使用 HTTP Basic Auth：

```text
Authorization: Basic base64(itop_user:itop_password)
```

如果你们的 iTop 禁用了 Basic Auth，需要先调整 iTop 认证方式，或者修改脚本。

## 3. Zabbix Media Type 配置

创建一个新的 Media type：

```text
Type: Webhook
Name: iTop simple webhook
Script: 粘贴 itop/zbx_itop_simple.js 的完整内容
Process tags: enabled
```

`Process tags` 必须开启。否则 problem 创建时返回的 `__zbx_itop_id` 不会写回事件，recovery 时脚本就不知道要关闭哪张 iTop 工单。

可选开启事件菜单：

```text
Include event menu entry: enabled
Menu entry name: iTop ticket: {EVENT.TAGS.__zbx_itop_key}
Menu entry URL:  {EVENT.TAGS.__zbx_itop_link}
```

## 4. 必需参数

Media type 里只需要下面这些必需参数。

| 参数名 | 推荐值 | 说明 |
| --- | --- | --- |
| `alert_subject` | `{ALERT.SUBJECT}` | iTop `title` |
| `alert_message` | `{ALERT.MESSAGE}` | iTop `description`，恢复时也会写入日志 |
| `event_source` | `{EVENT.SOURCE}` | 只支持 trigger event，必须解析为 `0` |
| `event_value` | `{EVENT.VALUE}` | `1` 表示 problem，`0` 表示 recovery |
| `itop_url` | `https://itop.example.com/` | iTop 根 URL |
| `itop_user` | `zabbix-rest` | iTop REST 用户 |
| `itop_password` | `{$ITOP.PASSWORD}` | iTop REST 密码，建议用 Zabbix secret/user macro |
| `itop_api_version` | `1.3` | iTop REST API version |
| `itop_class` | `UserRequest` | 目标工单类，也可以是 `Incident` |
| `itop_organization_id` | `1` | iTop organization 外键，数字 ID 或 OQL 都可以 |
| `itop_id` | `{EVENT.TAGS.__zbx_itop_id}` | recovery 时用于找到已创建的 iTop 工单 |
| `itop_log` | `private_log` | 恢复关闭时写日志；只能是 `private_log` 或 `public_log` |

最小配置示例：

```text
alert_subject={ALERT.SUBJECT}
alert_message={ALERT.MESSAGE}
event_source={EVENT.SOURCE}
event_value={EVENT.VALUE}

itop_url=https://itop.example.com/
itop_user=zabbix-rest
itop_password={$ITOP.PASSWORD}
itop_api_version=1.3
itop_class=UserRequest
itop_organization_id=1
itop_id={EVENT.TAGS.__zbx_itop_id}
itop_log=private_log
```

## 5. 推荐可选参数

这些参数按 iTop 本地数据模型决定是否需要。

| 参数名 | 示例 | 说明 |
| --- | --- | --- |
| `event_nseverity` | `{EVENT.NSEVERITY}` | 用于 severity 到 `impact` / `urgency` 的固定映射 |
| `HTTPProxy` | 留空或代理 URL | Zabbix webhook 代理 |
| `itop_caller_id` | `123` | caller，很多 `UserRequest` 模型会要求必填 |
| `itop_origin` | `monitoring` | 工单来源 |
| `itop_service_id` | `45` | 服务 |
| `itop_servicesubcategory_id` | `67` | 服务子类 |
| `itop_request_type` | `incident` | `UserRequest` 的请求类型，按本地枚举确认 |
| `itop_team_id` | `18` | 创建后用 `ev_assign` 分派到 team |
| `itop_agent_id` | `57` | 创建后用 `ev_assign` 分派到 agent |
| `itop_resolution_code` | `other` | recovery 时 resolve 使用的解决代码 |
| `itop_solution` | `Recovered by Zabbix` | recovery 时 resolve 使用的 solution |
| `itop_comment` | `Synchronized from Zabbix` | iTop REST comment |
| `itop_output_fields` | `id, friendlyname, status` | 建议保留 `id` 和 `friendlyname` |

推荐配置示例：

```text
event_nseverity={EVENT.NSEVERITY}
HTTPProxy=

itop_caller_id=123
itop_origin=monitoring
itop_service_id=45
itop_servicesubcategory_id=67
itop_request_type=incident
itop_team_id=18
itop_agent_id=57
itop_resolution_code=other
itop_comment=Synchronized from Zabbix
itop_output_fields=id, friendlyname, status
```

注意：simple 脚本的 team / agent 只能从 Media type 参数固定配置，不能从 Zabbix trigger tags 动态读取。

## 6. Action 配置重点

Zabbix Action 里建议只配置：

- Problem operations：发送到这个 iTop simple media type。
- Recovery operations：发送到这个 iTop simple media type。

不要配置 Update operations 调用这个脚本。simple 脚本没有读取 `event_update_status`，只要 `event_value=1` 就会创建新 iTop 工单。如果 update operation 也调用它，会导致同一个问题反复建单。

建议 problem subject：

```text
Problem: {EVENT.NAME}
```

建议 problem message：

```text
Host: {HOST.NAME}
Severity: {EVENT.SEVERITY}
Event ID: {EVENT.ID}

{EVENT.OPDATA}
```

建议 recovery subject：

```text
Resolved: {EVENT.NAME}
```

建议 recovery message：

```text
Host: {HOST.NAME}
Resolved at: {EVENT.RECOVERY.TIME}
Event ID: {EVENT.ID}

{EVENT.OPDATA}
```

## 7. 工单创建字段

problem 事件会调用 iTop `core/create`，写入这些字段：

| iTop 字段 | 来源 |
| --- | --- |
| `org_id` | `itop_organization_id` |
| `title` | `alert_subject` |
| `description` | `alert_message` |
| `impact` | `event_nseverity` 固定映射 |
| `urgency` | `event_nseverity` 固定映射 |
| `caller_id` | `itop_caller_id`，可选 |
| `origin` | `itop_origin`，可选 |
| `service_id` | `itop_service_id`，可选 |
| `servicesubcategory_id` | `itop_servicesubcategory_id`，可选 |
| `request_type` | `itop_request_type`，可选 |

severity 固定映射如下：

| Zabbix `event_nseverity` | iTop `impact` | iTop `urgency` |
| --- | --- | --- |
| `5` Disaster | `1` | `critical` |
| `4` High | `1` | `high` |
| `3` Average | `2` | `medium` |
| `2` Warning | `3` | `low` |
| `1` Information | `3` | `low` |
| `0` Not classified | `3` | `low` |

如果你们 iTop 的 `impact` 或 `urgency` 内部值不同，需要修改 `zbx_itop_simple.js` 顶部的 `SEVERITY_MAP`。

## 8. 恢复关闭流程

recovery 事件会读取：

```text
itop_id={EVENT.TAGS.__zbx_itop_id}
```

然后执行：

1. `core/apply_stimulus` + `ev_resolve`
2. `core/apply_stimulus` + `ev_close`

`ev_resolve` 会写入：

- `solution`
- `resolution_code`
- `private_log` 或 `public_log`

如果你们的 iTop 不允许自动关闭，只想创建工单，不要在 Zabbix Action 的 Recovery operations 里调用这个 media type。simple 脚本没有 `itop_auto_close=false` 这种开关。

## 9. 测试

### 9.1 测试创建

在 Media type Test 中填入类似参数：

```text
alert_subject=Problem: test alert
alert_message=Host: test-host
event_source=0
event_value=1
event_nseverity=4

itop_url=https://itop.example.com/
itop_user=zabbix-rest
itop_password=******
itop_api_version=1.3
itop_class=UserRequest
itop_organization_id=1
itop_id={EVENT.TAGS.__zbx_itop_id}
itop_log=private_log
itop_caller_id=123
```

成功时返回值应包含：

```json
{
  "tags": {
    "__zbx_itop_id": "123",
    "__zbx_itop_key": "R-000123",
    "__zbx_itop_link": "https://itop.example.com/pages/UI.php?operation=details&class=UserRequest&id=123"
  }
}
```

### 9.2 测试恢复

把上一步返回的 ID 填入 `itop_id`：

```text
alert_subject=Resolved: test alert
alert_message=Host: test-host recovered
event_source=0
event_value=0

itop_id=123
```

成功时 iTop 工单应先变为 resolved，再变为 closed。

## 10. 常见问题

### recovery 时报 `iTop ticket ID is not available`

通常是 Zabbix 没拿到创建时写回的 tag。

检查：

- Media type 是否开启 `Process tags`。
- `itop_id` 是否配置为 `{EVENT.TAGS.__zbx_itop_id}`。
- problem 创建通知是否成功执行过。
- 是否存在“创建后立刻恢复”的极端情况，导致 recovery 执行时 tag 还没写回。

### 创建了多张重复工单

通常是 Action 的 Update operations 也调用了 simple 脚本。

处理：

- 删除或禁用该 Action 下调用 iTop simple media type 的 Update operations。
- 只保留 Problem operations 和 Recovery operations。

### `ev_assign` 失败但创建成功

simple 脚本把分派失败当作非致命错误，只写 Zabbix debug log，不阻断创建。

常见原因：

- 当前状态不允许 `ev_assign`。
- `team_id` / `agent_id` 不符合 iTop delivery model。
- 只传了 team 或只传了 agent，但本地生命周期要求两者都传。

### `ev_resolve` 或 `ev_close` 失败

常见原因：

- 当前状态不允许这些 stimulus。
- `resolution_code` 不符合本地枚举。
- 本地 iTop 对 resolve/close 有额外必填字段，但 simple 脚本没有传。

这种情况需要调整 iTop 生命周期、补充脚本字段，或改用完整版本 `zbx_itop.js`。

