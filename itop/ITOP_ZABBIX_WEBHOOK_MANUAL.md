# Zabbix iTop Ticketing Webhook 使用手册

本文档说明 `zbx_itop.js` 的集成流程、必要参数、推荐的 Zabbix tags 设计，以及自动关闭、自动分派、优先级映射的实现方式。

脚本目标：

- Zabbix 问题事件创建 iTop 工单。
- Zabbix 事件更新时追加 iTop 工单日志。
- Zabbix 恢复事件自动 resolve/close iTop 工单。
- 按 Zabbix severity 映射 iTop `impact` / `urgency`，由 iTop 自动计算 `priority`。
- 根据 Zabbix event tags 或 Media type 参数分派给 iTop team/agent。

参考资料：

- iTop REST/JSON services: https://www.itophub.io/wiki/page?id=3_1_0%3Aadvancedtopics%3Arest_json
- iTop User Request data model: https://www.itophub.io/wiki/page?id=3_0_0%3Adatamodel%3Aitop-request-mgmt
- Zabbix Webhook media type: https://www.zabbix.com/documentation/8.0/en/manual/config/notifications/media/webhook
- Zabbix webhook development guidelines: https://www.zabbix.com/documentation/guidelines/en/webhooks

## 1. 运行前提

### 1.1 iTop 侧要求

iTop REST 账号需要满足：

- 能访问 REST API。
- iTop 2.5+ 通常需要 `REST Services User` profile。
- 对目标工单类有创建、更新、生命周期动作权限。
- 对 `UserRequest` / `Incident` 这类工单，一般还需要支持人员相关 profile。

脚本默认使用 HTTP Basic Auth：

```text
Authorization: Basic base64(itop_user:itop_password)
```

如果 iTop 禁用了 Basic Auth，需要调整 iTop 登录方式或改脚本请求参数。

### 1.2 iTop 生命周期要求

自动分派和自动关闭不是直接改 `status` 字段，而是调用：

```json
{
  "operation": "core/apply_stimulus",
  "stimulus": "ev_assign"
}
```

常见刺激名：

| 场景 | 默认 stimulus | 说明 |
| --- | --- | --- |
| 分派给 team + agent | `ev_assign` | 新建后从 new 进入 assigned |
| 重新分派 | `ev_reassign` | 更新已有工单时使用 |
| 只分派给 team | `ev_dispatch` | 通常需要 iTop Dispatch 扩展 |
| 恢复后解决 | `ev_resolve` | 写入 `solution` / `resolution_code` |
| 恢复后关闭 | `ev_close` | 从 resolved 进入 closed |

不同 iTop 版本、模块、客户化生命周期可能不一样。上线前应在 iTop REST Playground 或测试环境确认这些 stimulus 名称。

### 1.3 Zabbix 侧要求

Media type 需要启用：

- `Process tags`：必须启用，否则脚本返回的 `__zbx_itop_id` 不会写回 Zabbix event tags。
- 如果要在问题页面显示 iTop 链接，启用 `Include event menu entry`。

推荐菜单配置：

```text
Menu entry name: iTop ticket: {EVENT.TAGS.__zbx_itop_key}
Menu entry URL:  {EVENT.TAGS.__zbx_itop_link}
```

注意：Zabbix webhook 返回的 tags 是 webhook 执行后才写入事件的。如果问题刚创建就立即恢复，恢复动作可能拿不到 `__zbx_itop_id`，这种极端场景需要延迟恢复通知或在 iTop 自定义字段中保存 Zabbix event id 后扩展反查逻辑。

## 2. 整体流程

### 2.1 问题创建

触发条件：

```text
event_source = 0
event_value = 1
event_update_status = 0
itop_id = {EVENT.TAGS.__zbx_itop_id}
```

脚本动作：

1. 调用 iTop `core/create` 创建工单。
2. 写入 `org_id`、`title`、`description`。
3. 写入 priority 映射后的 `impact` / `urgency`。
4. 可选写入 caller、origin、service、request type 等字段。
5. 返回 Zabbix tags：
   - `__zbx_itop_id`
   - `__zbx_itop_key`
   - `__zbx_itop_link`
6. 如果有 team/agent，继续调用 `core/apply_stimulus` 执行分派。

### 2.2 问题更新

触发条件：

```text
event_source = 0
event_update_status = 1
```

脚本动作：

1. 调用 iTop `core/update`。
2. 追加 `private_log` 或 `public_log`。
3. 默认更新 title。
4. 问题仍未恢复时，按当前 severity 更新 `impact` / `urgency`。
5. 如果 `itop_assign_on_update=true`，根据当前参数重新分派。

### 2.3 问题恢复

触发条件：

```text
event_source = 0
event_value = 0
```

脚本动作：

1. 调用 iTop `core/update` 追加恢复日志。
2. 如果 `itop_auto_close=true`：
   - 默认先执行 `ev_resolve`，并写入 `solution` / `resolution_code`。
   - 再执行 `ev_close`。

默认恢复 stimulus：

```text
itop_recovery_stimuli=ev_resolve,ev_close
```

如果你们只希望自动解决、不自动关闭，改成：

```text
itop_recovery_stimuli=ev_resolve
```

## 3. Zabbix Media Type 参数

下面是建议配置。已有参数可以保留，新参数按需增加。

### 3.1 Zabbix 事件参数

| 参数名 | 推荐值 | 必需 | 说明 |
| --- | --- | --- | --- |
| `alert_subject` | `{ALERT.SUBJECT}` | 是 | iTop title |
| `alert_message` | `{ALERT.MESSAGE}` | 是 | iTop description/log |
| `summary` | `{EVENT.NAME}` | 是 | 保持原脚本兼容 |
| `event_source` | `{EVENT.SOURCE}` | 是 | Zabbix event source |
| `event_value` | `{EVENT.VALUE}` | 是 | `1` problem，`0` recovery |
| `event_update_status` | `{EVENT.UPDATE.STATUS}` | 是 | `1` 表示 problem update |
| `event_recovery_value` | `{EVENT.RECOVERY.VALUE}` | 是 | 原脚本兼容参数，非 trigger 事件判断会用到 |
| `event_nseverity` | `{EVENT.NSEVERITY}` | 建议 | severity 数字 0-5 |
| `event_tags_json` | `{EVENT.TAGSJSON}` | 建议 | 从 Zabbix tags 读取 team/agent/impact/urgency |
| `event_id` | `{EVENT.ID}` | 建议 | 用于幂等性保护，防止重试时重复创建工单 |
| `action_name` | `{ACTION.NAME}` | 是 | 保持原脚本兼容 |
| `HTTPProxy` | 留空或代理 URL | 否 | Zabbix webhook 代理 |

### 3.2 iTop 基础参数

| 参数名 | 示例 | 必需 | 说明 |
| --- | --- | --- | --- |
| `itop_url` | `https://itop.example.com/` | 是 | iTop 根 URL |
| `itop_user` | `zabbix-rest` | 是 | REST 用户 |
| `itop_password` | `{$ITOP.PASSWORD}` | 是 | REST 密码，建议用 Zabbix secret/user macro |
| `itop_api_version` | `1.3` | 是 | iTop REST API version |
| `itop_class` | `UserRequest` | 是 | 目标工单类，也可以是 `Incident` |
| `itop_organization_id` | `SELECT Organization WHERE name = "Demo"` 或 `1` | 是 | iTop org 外键 |
| `itop_id` | `{EVENT.TAGS.__zbx_itop_id}` | 是 | 已创建工单 id，首次创建时是未解析宏 |
| `itop_log` | `private_log` | 是 | `private_log` 或 `public_log` |
| `itop_comment` | `Synchronized from Zabbix` | 否 | iTop REST comment |
| `itop_output_fields` | `id, friendlyname, status` | 否 | 不建议移除 `id` / `friendlyname` |

### 3.3 iTop 常用创建字段

这些字段会在 `core/create` 时写入：

| 参数名 | 示例 | 说明 |
| --- | --- | --- |
| `itop_caller_id` | `123` 或 `SELECT Person WHERE email = "noc@example.com"` | UserRequest/Incident 常见必填字段 |
| `itop_origin` | `monitoring` | 来源 |
| `itop_service_id` | `SELECT Service WHERE name = "Monitoring"` | 服务 |
| `itop_servicesubcategory_id` | `SELECT ServiceSubcategory WHERE name = "Alert"` | 服务子类 |
| `itop_request_type` | `incident` | UserRequest 的 request type，按本地模型确认 |
| `itop_create_fields_json` | `{"caller_id":123,"origin":"monitoring"}` | 任意额外 create 字段 |

如果某字段在你们 iTop 中是必填，但上表没有覆盖，用 `itop_create_fields_json` 补充。

## 4. 优先级映射

iTop 标准模型里 `priority` 通常是只读字段，由 `impact` + `urgency` 自动计算。因此脚本默认不会直接写 `priority`，而是写：

- `impact`
- `urgency`

默认映射：

```json
{
  "5": {"impact": "1", "urgency": "critical"},
  "4": {"impact": "1", "urgency": "high"},
  "3": {"impact": "2", "urgency": "medium"},
  "2": {"impact": "3", "urgency": "low"},
  "1": {"impact": "3", "urgency": "low"},
  "0": {"impact": "3", "urgency": "low"}
}
```

Zabbix severity 数字含义：

| Zabbix 数字 | 含义 |
| --- | --- |
| `0` | Not classified |
| `1` | Information |
| `2` | Warning |
| `3` | Average |
| `4` | High |
| `5` | Disaster |

iTop `impact` 的内部值需要按本地 datamodel 确认。常见情况下：

| iTop impact 值 | 含义 |
| --- | --- |
| `1` | A department |
| `2` | A service |
| `3` | A person |

### 4.1 覆盖默认映射

在 Media type 增加：

```text
itop_severity_map={"5":{"impact":"1","urgency":"critical"},"4":{"impact":"1","urgency":"high"},"3":{"impact":"2","urgency":"medium"},"2":{"impact":"3","urgency":"low"},"1":{"impact":"3","urgency":"low"},"0":{"impact":"3","urgency":"low"}}
```

### 4.2 使用 Zabbix tags 直接覆盖

在 trigger 或 template 上添加 tags：

```text
itop_impact=1
itop_urgency=high
```

脚本优先级：

1. `itop_impact` / `itop_urgency` Media type 参数。
2. Zabbix event tags 中的 `itop_impact` / `itop_urgency`。
3. `itop_severity_map`。

### 4.3 直接写 priority

不推荐，除非你们 iTop 已经客户化并允许写 `priority`。

启用方式：

```text
itop_set_priority_directly=true
itop_priority=high
```

或者用 tag：

```text
itop_priority=high
```

## 5. 自动分派

脚本支持两种来源：

1. Media type 参数直接配置。
2. Zabbix trigger/template tags 动态传入。

### 5.1 推荐：通过 Zabbix tags 分派

在 trigger 或 template 上添加：

```text
itop_team_id=18
itop_agent_id=57
```

Media type 中需要有：

```text
event_tags_json={EVENT.TAGSJSON}
```

首次创建工单后，脚本会执行：

```json
{
  "operation": "core/apply_stimulus",
  "class": "UserRequest",
  "key": 123,
  "stimulus": "ev_assign",
  "fields": {
    "team_id": "18",
    "agent_id": "57"
  }
}
```

### 5.2 直接用 Media type 参数分派

```text
itop_team_id=18
itop_agent_id=57
```

这种方式适合所有告警固定进入一个团队或一个值班账号。

### 5.3 参数说明

| 参数名 | 默认值 | 说明 |
| --- | --- | --- |
| `itop_team_id` | 空 | 固定 team id 或 OQL |
| `itop_agent_id` | 空 | 固定 agent id 或 OQL |
| `itop_team_id_tag` | `itop_team_id` | 从哪个 Zabbix tag 读取 team |
| `itop_agent_id_tag` | `itop_agent_id` | 从哪个 Zabbix tag 读取 agent |
| `itop_assign_on_create` | `true` | 创建后自动分派 |
| `itop_assign_on_update` | `false` | 更新事件时重新分派 |
| `itop_assign_stimulus` | `ev_assign` | 新建后分派 stimulus |
| `itop_reassign_stimulus` | `ev_reassign` | 更新时重新分派 stimulus |
| `itop_assignment_stimulus` | 空 | 强制覆盖分派 stimulus |
| `itop_assign_fields_json` | `{}` | 分派时额外字段 |

### 5.4 只分派给 team

iTop 标准 UserRequest/Incident 生命周期通常要求 team + agent 一起设置。如果你们安装了 Dispatch User Request 或 Dispatch Incident 扩展，才建议启用只分派 team：

```text
itop_assign_team_only=true
itop_dispatch_stimulus=ev_dispatch
```

并只传：

```text
itop_team_id=18
```

如果没有 Dispatch 扩展，这一步通常会被 iTop 拒绝。

## 6. 自动关闭

默认不开启自动关闭。开启：

```text
itop_auto_close=true
```

默认恢复动作：

```text
itop_recovery_stimuli=ev_resolve,ev_close
```

恢复时脚本会：

1. 追加日志。
2. 执行 `ev_resolve`，写入：
   - `solution`
   - `resolution_code`
   - 当前配置的 log 字段
3. 执行 `ev_close`。

### 6.1 自动关闭参数

| 参数名 | 默认值 | 说明 |
| --- | --- | --- |
| `itop_auto_close` | `false` | 是否在 Zabbix recovery 时自动 resolve/close |
| `itop_recovery_stimuli` | `ev_resolve,ev_close` | 逗号分隔的 lifecycle stimuli |
| `itop_resolution_code` | `other` | iTop resolution code |
| `itop_solution` | 自动生成 | iTop solution |
| `itop_recovery_fields_json` | `{}` | 恢复时额外字段 |

### 6.2 只解决不关闭

```text
itop_auto_close=true
itop_recovery_stimuli=ev_resolve
```

### 6.3 自定义恢复字段

例如你们 iTop 的解决代码不是 `other`：

```text
itop_resolution_code=bug fixed
```

如果还需要自定义字段：

```text
itop_recovery_fields_json={"solution":"Recovered automatically by Zabbix","resolution_code":"other"}
```

`itop_recovery_fields_json` 会覆盖同名默认字段。

## 7. 其他扩展字段

### 7.1 创建时额外字段

```text
itop_create_fields_json={"caller_id":123,"origin":"monitoring","service_id":45}
```

### 7.2 更新时额外字段

```text
itop_update_fields_json={"origin":"monitoring"}
```

### 7.3 分派时额外字段

```text
itop_assign_fields_json={"team_id":18,"agent_id":57}
```

### 7.4 是否更新 title

默认每次 update 都更新 title：

```text
itop_update_title=true
```

如果恢复时或更新时碰到 title 只读导致失败，可以改为：

```text
itop_update_title=false
```

### 7.5 日志格式

默认：

```text
itop_log_format=text
```

可改为：

```text
itop_log_format=html
```

## 8. 推荐最小配置

### 8.1 Media type 参数

```text
alert_subject={ALERT.SUBJECT}
alert_message={ALERT.MESSAGE}
summary={EVENT.NAME}
event_source={EVENT.SOURCE}
event_value={EVENT.VALUE}
event_update_status={EVENT.UPDATE.STATUS}
event_recovery_value={EVENT.RECOVERY.VALUE}
event_nseverity={EVENT.NSEVERITY}
event_tags_json={EVENT.TAGSJSON}
event_id={EVENT.ID}
action_name={ACTION.NAME}
HTTPProxy=

itop_url=https://itop.example.com/
itop_user=zabbix-rest
itop_password={$ITOP.PASSWORD}
itop_api_version=1.3
itop_class=UserRequest
itop_organization_id=1
itop_id={EVENT.TAGS.__zbx_itop_id}
itop_log=private_log
itop_comment=Synchronized from Zabbix

itop_caller_id=123
itop_origin=monitoring
itop_auto_close=true
```

### 8.2 Trigger tags

```text
itop_team_id=18
itop_agent_id=57
```

可选覆盖优先级：

```text
itop_impact=1
itop_urgency=critical
```

## 9. 测试步骤

### 9.1 测试创建

在 Zabbix Media type Test 中手动填入：

```text
event_source=0
event_value=1
event_update_status=0
event_nseverity=4
event_tags_json=[{"tag":"itop_team_id","value":"18"},{"tag":"itop_agent_id","value":"57"}]
itop_id={EVENT.TAGS.__zbx_itop_id}
```

预期：

- iTop 创建新工单。
- iTop 工单进入 assigned，team/agent 正确。
- Zabbix 测试返回 JSON 包含：

```json
{
  "tags": {
    "__zbx_itop_id": "123",
    "__zbx_itop_key": "R-000123",
    "__zbx_itop_link": "https://itop.example.com/pages/UI.php?operation=details&class=UserRequest&id=123"
  }
}
```

### 9.2 测试更新

使用上一步返回的 id：

```text
event_source=0
event_value=1
event_update_status=1
itop_id=123
```

预期：

- iTop 工单追加 private/public log。
- 如果 severity 改变，`impact` / `urgency` 随之更新。

### 9.3 测试恢复关闭

```text
event_source=0
event_value=0
event_update_status=0
itop_id=123
itop_auto_close=true
itop_recovery_stimuli=ev_resolve,ev_close
```

预期：

- iTop 工单追加恢复日志。
- 工单先 resolved，再 closed。

如果失败，重点检查：

- 当前工单状态是否允许 `ev_resolve`。
- resolved 状态是否允许 `ev_close`。
- `solution` / `resolution_code` 是否满足 mandatory 字段要求。
- REST 用户是否有执行 lifecycle stimulus 的权限。

## 10. 常见错误

### 10.1 `Incorrect iTop ticket ID given`

恢复或更新时没有拿到 `__zbx_itop_id`。

处理：

- 确认 Media type 启用了 `Process tags`。
- 确认 `itop_id={EVENT.TAGS.__zbx_itop_id}`。
- 确认问题创建动作已经成功执行过。
- 对“创建后立即恢复”的场景，考虑延迟恢复通知或扩展 iTop 自定义字段反查。

### 10.2 `Request failed with iTop code 1`

通常是权限问题。

处理：

- 检查 REST 用户密码。
- 检查 REST Services User profile。
- 检查目标类的写权限和 bulk write 权限。
- 检查 Support Agent 或对应 profile 是否能执行分派/关闭。

### 10.3 `ev_assign` 失败

常见原因：

- 当前状态不允许 `ev_assign`。
- 缺少 `team_id` 或 `agent_id`。
- team 不在该组织/客户的 delivery model 中。
- `agent_id` 不属于该 team。

处理：

- 确认 iTop UI 中同样的 team/agent 能手工分派。
- 更新 `itop_assign_stimulus` 或 `itop_reassign_stimulus`。
- 如果只想分派 team，安装 Dispatch 扩展并配置 `itop_assign_team_only=true`。

### 10.4 `ev_resolve` 或 `ev_close` 失败

常见原因：

- 当前状态不允许该 stimulus。
- 缺少 mandatory 字段。
- `resolution_code` 值不符合本地枚举。

处理：

- 先改成 `itop_recovery_stimuli=ev_resolve` 测试。
- 用 `itop_recovery_fields_json` 补齐本地必填字段。
- 在 iTop datamodel 或 UI 中确认真实 stimulus 名称。

### 10.5 priority 没变

可能原因：

- iTop priority 是自动计算字段，不能直接写。
- `impact` / `urgency` 内部值不符合本地枚举。
- 工单当前状态下 `impact` / `urgency` 只读。

处理：

- 确认 `event_nseverity={EVENT.NSEVERITY}`。
- 检查 `itop_severity_map` 中的 impact/urgency 是否是本地真实值。
- 不要启用 `itop_set_priority_directly`，除非本地模型允许写 priority。

## 11. 上线建议

建议按顺序启用：

1. 只启用创建和日志更新，确认原流程稳定。
2. 增加 `event_nseverity` 和默认 severity mapping。
3. 增加 trigger tags：`itop_team_id` / `itop_agent_id`。
4. 测试自动分派。
5. 在测试环境启用 `itop_auto_close=true`。
6. 确认恢复事件能 resolve/close 后，再在生产 action 中启用。

生产上建议先使用：

```text
itop_auto_close=true
itop_recovery_stimuli=ev_resolve
```

确认 iTop 流程允许自动关闭后，再改为：

```text
itop_recovery_stimuli=ev_resolve,ev_close
```
