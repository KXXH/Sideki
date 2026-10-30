# 后台任务与多会话并发的 Tab 归属模型

本文描述当前代码实现。turn 栈、跨会话锁、页面/面板指示器、定时任务与页面监听均已接线；“为任务新建 inactive 空白 tab 并拦截 `_blank`”属于早期设想，**不是当前任务行为**。

## 为什么不能跟随窗口的 active tab

offscreen 内核允许面板切到会话 B 时，会话 A 的 turn 继续执行。若每次工具调用都重新取窗口 active tab，用户切页或另一任务打开新 tab 就会改变 A 的操作目标。

当前使用每 session 的 turn 级 tab 栈：工具跟随本 turn 栈顶，只有属于该 turn 的导航或明确的 tab 命令才改变栈顶。锁在 session 之间仲裁，不阻挡用户手工操作网页。

## 运行时与注册表

- `src/background/tab-locks.ts`：SW 中的 `stacks` Map，以 sessionId 为键保存 `stack` 与 `touchedAt`。
- `src/shared/tools/bridge.ts`：`resolveTabId()` 通过 `env:operating-tab` 请求解析；撞锁错误反馈给模型。
- `src/background/service-worker.ts`：接收解析、touch、release、query 消息，注册导航与 tab 关闭事件。
- `SidekickKernel`：在实际 dispatch 前调用宿主注入的 `onTurnStart`，覆盖直发和队列续发。

SW 是两种内核宿主共享的浏览器执行入口，但不是永久驻留进程。该 Map 是内存状态，不能把“注册表在 SW”理解成浏览器不会挂起它；宿主保活与 120 秒过期兜底只能降低相关风险。

## 普通 turn 的 seed

`SessionRuntime` 和 panel hook 均在 turn 起点调用 `acquireTurnTab()`。底层解析器也支持尚无栈时首次工具调用建栈，但正常 dispatch 已经提前 seed；纯文本 turn 也可能持锁。

解析规则：

1. 已有本 session 的栈，返回栈顶并刷新 touchedAt。
2. exact/pinned anchor 直接作为目标。
3. 普通 anchor 只定位所属窗口，seed 取该窗口当前 active tab。
4. anchor 不可用时回退 lastFocusedWindow 的 active tab。
5. seed 被别的 session 持有，返回 blocked，不新建本 session 的栈。

普通 `acquireTurnTab()` 吞掉 seed 失败，使无工具的文字回复仍能进行；后续工具再收到具体忙碌错误。定时任务的 `schedule:acquire` 失败则会中断本次任务派发，避免绑定页丢失时误用别的页面。

## 栈变化

| 操作 | 触发与结果 |
|------|------------|
| push | `webNavigation.onCreatedNavigationTarget` 的 sourceTabId 等于本栈顶时，新 tab 入栈 |
| 显式 target | `chrome tabs --switch` / `--new` 调用 `noteExplicitOperatingTab()`；已在栈里先移除旧位置，再移到栈顶 |
| remove | `tabs.onRemoved` 将该 tab 从所有相关栈剔除；顶层关闭后退到前一层，空栈删除 |
| 原地导航 | URL 改变但 tabId 不变，栈不变；页面工作指示器在导航后重新注入 |
| release | 删除整个 session 栈，清理鼠标状态、指针并广播无操作 tab |

不能依赖 `tabs.onActivated` 迁移任务目标；它只是面板 tab/session UI 的信号。程序化 `tabs.create` 与用户页面触发新页的事件来源不同，因此显式命令自己声明目标，不依赖新导航事件。

关闭栈顶 tab **不等同于释放整栈**：若还有底层 tab，turn 会继续持有并回退到它。

## 所有权与 gate

所有权覆盖整个栈，而非只覆盖栈顶。一个 turn 可能从新页返回原页，若提前释放底层页，另一会话就可占用它，造成回退后冲突。

- 隐式页面工具解析时，目标被其他 session 持有就失败，不排队。
- `chrome tabs --close/--switch` 等显式目标经 `gateExplicitTab()` 检查。
- 本 session 自己的 tab 允许操作；新建 tab 无旧所有权冲突。
- 分组类操作没有完整套用同样的页面所有权 gate，不能宣称全部 Chrome API 命令都被相同规则拦截。

隐式解析不区分读写，`getPageContent`、`screenshot` 与 bash 页面命令也会收到撞锁错误。Chat 的冻结提示词可能已包含页面内容，无工具回答不必依赖重新取页。

错误文案分两类：隐式“当前页忙”要求停止并交由用户决定；显式 tab 忙允许跳过非必要目标或换其他显式目标。重复对同一忙页重试不会解决冲突。

## turn 边界、队列与保活

### 释放时机

`wireTurnAutomation()` 和 panel hook 在 status 从运行态进入 ready 时判断 `kernel.hasQueuedContinuation`：

- 队列仍有连续发送：touch 保留原栈，下一项继续使用同一操作上下文，避免用户在交接间隙切页导致重定向。
- 队列已排空：release。
- error 是终态，不会自然进入 ready，因此有独立 release。
- stop、runtime dispose 等路径也会发 release；释放幂等。

### 保活与过期

- panel 宿主：非 ready 且非镜像模式时，每 20 秒发送 `tab-lock:touch`。
- offscreen 宿主：kstate 订阅更新时，以 20 秒阈值节流发送 touch；**它不是独立每 20 秒必定运行的计时器**，没有状态更新时不会仅凭这段代码发心跳。
- 解析/栈迁移也刷新 touchedAt。
- `STALE_MS = 120_000`。读取/更新注册表时 prune 过期栈，不是独立 alarm 精确在第 120 秒清理。
- `touchTurn()` 先 prune 再续期，已过期的栈不能复活，因为其 tab 可能已被其他 session 取得。

保活同时续租页面工作指示器；过期清理必须隐藏旧指针和页面提示，否则注册表丢失后无人能清理残留 UI。

### 页面灵动岛的活动文案

两宿主从正在生成/执行的内置工具调用中提取完整 `description`，以 `tab-lock:activity` 推送到 SW。描述只投影到当前 session 的栈顶页面，并在导航、心跳续租和指示器重新启用时恢复；释放或过期清理时删除。

`page-lock-indicator.ts` 在页面 isolated world 内维护展示计时器，不依赖 SW 的短计时器跨挂起存活。最新候选持续至少 600ms 才显示；标题每次变更后至少停留 2 秒，期间只保留最新的仍活跃候选，不排队播放旧操作。没有候选时恢复「Agent 正在此页工作」，恢复同样遵守停留时间；turn 结束隐藏立即进入退出动画并取消所有活动更新，不等待 2 秒。准备参数阶段以「准备：」标记，执行阶段展示中性的动作描述，不宣称操作已成功。

更新仅改变文字和悬停展开宽度，不重新挂载灵动岛。文案以 `textContent` 写入，长标题省略并提供完整悬停提示；模型描述不作为 HTML 或执行指令。

## 定时任务与页面监听：当前实现

`scheduled-tasks.ts` 已实现 `schedule` 和 `monitor`，并通过 0.5 分钟的 alarm 周期检查到期任务。它们需要后台内核，panel 宿主下创建会被拒绝；已存在活跃任务在调度时会暂停。

### 绑定原页面，而不是创建空白页

创建任务时记录本 session 当前操作 tab（没有则取调用传入 tabId）、页面标题/URL 和 tab 栈。等待期间不持续持锁。

唤醒时检查：

1. 会话仍存在；同 session 没有其他 running 调度任务。
2. 绑定 tab 仍存在。
3. 目标栈没有别的 session 持有。
4. monitor 的 documentId 仍匹配、唤醒间隔已到。

目标忙时任务进入 waiting，页面关闭时暂停。运行前 `schedule:acquire` 恢复该任务的 tab 栈，runtime 将目标置为 pinned；解析失败不能降级到用户 active tab。

普通定时任务执行后，`captureScheduledTab()` 在 release 前保存当时栈和栈顶，下次从其后续位置恢复。monitor 则固定到安装监听的 document；刷新/导航后需要重新创建监听。

`monitor.create` 可选 `frame` 参数，省略时监听顶层文档；可传顶层文档中的 iframe CSS 选择器，或数字 frameId（如 `"7"` / `"#7"`，可定位嵌套 iframe），定位语义复用 `js --frame`。跨源 iframe 在 Chrome 允许注入时可监听；重复 URL 无法唯一定位时须使用 frameId。监听函数的 `window` / `document` 指向目标 frame，事件必须同时匹配 tabId、frameId 和 documentId。目标 frame 导航或顶层页面导航后停止监听，iframe 被移除/祖先 frame 替换由约 30 秒的 alarm 文档检查发现；不自动重绑。iframe 注入或 CSP 执行失败会明确报错，不自动使用 CDP 回退。

例如监听指定 iframe 中的停止按钮，代码应先订阅 DOM 变化，再检查当前状态，并记录“已出现 → 消失”的转换，避免把初次未找到按钮误判为完成。`frame` 是原生工具参数，目前没有 Bash `monitor` 命令。

浏览器重启后，`chrome.storage.session` 的 boot 标识丢失，未结束任务暂停并标记 requiresRebind，不能沿用旧 tabId。任务状态本身存于 `chrome.storage.local`。

### 当前没有的隔离能力

没有为每个任务自动创建 inactive 空白 tab，也没有全局 `_blank`/`window.open` 拦截。任务操作仍可能让站点打开前台新页；turn 栈负责正确归属，不承诺任务全程不抢焦点。若目标 tab 已在后台，截图会明确拒绝，避免拍到用户另一个前台 tab。

## UI 投影

面板页面信息条是上下文指向的权威显示：

| 状态 | 含义 |
|------|------|
| locked | 用户手动固定上下文 |
| held | turn 栈持有操作页，可能与用户浏览页不同 |
| free | 未固定也未持栈，跟随用户当前 tab |

SW 在栈顶变化时广播 `tab-lock:changed`；面板挂载/切会话时用 `tab-lock:query` 补读。用户上下文固定与 turn 所有权是不同维度，不应混为同一把锁。

页面侧为顶部状态指示器和边缘光效，默认圆形收起、hover 展开。页面提示只显示状态，不提供 Stop；受 `pageLockIndicator` 开关控制。`aiPointer` 是独立开关。页面提示可能注入失败或被站点遮挡；面板信息条仍为权威状态。当前没有页面标题前缀投影。

## 验证入口与限制

| 代码/测试 | 职责 |
|-----------|------|
| `src/background/tab-locks.ts` | 栈、所有权、gate、TTL、UI 通知 |
| `src/shared/tools/bridge.ts` | 工具 tab 解析与普通 turn seed |
| `src/background/chrome-commands.ts` | 显式 switch/new/close 的 gate 和目标迁移 |
| `src/shared/kernel/turn-automation.ts` | 后台 turn 边界与保活 |
| `src/shared/kernel/kernel-runtime.ts` | 普通/调度 turn seed、dispose |
| `src/background/scheduled-tasks.ts` | 任务绑定、等待、恢复、重启暂停 |
| `src/background/monitor-page.ts` | 页面监听安装、事件中转、清理 |
| `tests/unit/tab-locks.test.ts`、`tests/unit/tool-ctx.test.ts` | 栈与工具上下文单测 |
| `tests/unit/scheduled-tasks.test.ts`、`tests/unit/monitor-page.test.ts` | 调度与监听单测 |

仍需真机验证：多窗口并发、真实 `_blank` 来源、长时间无流事件的保活、SW 被回收时状态恢复、导航期间 overlay 重建、浏览器重启后的重新绑定、后台页截图错误。CDP popup 拦截只是早期探索，不能据此声称当前已具备。
