[English](README.md) · **简体中文**

# qbit-swap coordinator

一个**无密钥、非托管**的服务，用于编排 BTC↔QBT 原子兑换。它从不持有密钥、
资金或原像（直到原像在链上公开为止）。它派生出两个 HTLC 地址，监视两条
链，在满足抗重组的确认数（`getconfirmationtarget`）后才放行领取，广播
由对手方签名的交易，并公开已揭示的原像。浏览器 web 应用和无界面的做市
**bot** 都通过同一套 HTTP API 驱动它。

## Pieces
- `chain.js` — 面向两个节点的无密钥链适配器（区块高度、`getconfirmationtarget`、`scantxoutset`
  注资监视、确认数、`testmempoolaccept`/`sendrawtransaction`）。dev 传输通过 ssh 调用
  回归测试网的命令行工具；生产适配器将 `rpc()` 替换为直接的 JSON-RPC。
- `swap.js` — swap 存储 + Tier-Nolan 状态机
  （`CREATED→READY→BTC_FUNDED→QBT_FUNDED→MATURING→CLAIMABLE→CLAIMED→COMPLETE`，另加 `REFUNDED`/`ABORTED`）。
- `server.js` — HTTP/JSON API + 链监视循环；通过每个对手方的能力令牌进行鉴权。
- `admin.js` — **只读监控仪表盘**（见下文）。
- `demo.js` — 两个无界面 bot 通过 API 走完整个 swap，使用 `../js` 在客户端签名。

## Admin dashboard (`admin.js`)
一个独立的进程内 HTTP 服务器（`startAdmin(port)`，默认 `8790`），为运营者提供存储的实时
视图 —— 概览计数、链高度/后端、一张可筛选的全部 swap 表格（状态、
金额、注资、对手方是否到场、看守塔是否已装填状态）、订单簿，以及一个 SSE 活动流。
它直接读取内存中的实时存储（无需轮询数据库；由全局 `subscribeAll` 驱动活动流），
**不暴露任何变更端点**，并**隐去能力令牌**。由 `ADMIN_TOKEN` 把关
（`?token=` 或 `X-Admin-Token`；未设置时会生成一个随机值并记录到日志）。`serve.js`/`trial.js` 会自动启动
它，除非 `ADMIN=off`。它应当通过私有网络访问（例如 tailnet），
切勿公开暴露 —— 用 `ADMIN_BIND` 绑定，并使其远离任何公开的反向代理。
- `GET /` dashboard · `GET /api/overview` · `GET /api/swaps[?state=]` · `GET /api/swaps/:id` ·
  `GET /api/offers` · `GET /stream` (SSE)

## API (auth: `X-Swap-Token`, header or `?token=`)
- `POST /swaps` → `{ id, tokens: { alice, bob } }`（Alice 把 Bob 的令牌作为他的链接分享给他）
- `POST /swaps/:id/party` — 提交 `{ qbitPub, btcPub, btcDest, qbitDest, H? }`
- `GET  /swaps/:id` — 对手方视图：两条腿的 HTLC 地址、注资（+`spent`）、确认数、链
  `heights`、`state`、每条腿的退款可用性，以及 `preimage`（仅在链上公开后才有）
- `GET  /swaps/:id/events` — **Server-Sent Events**：在每次状态变化时推送相同的视图（
  web 应用和 bot 订阅它而非轮询）
- `POST /swaps/:id/broadcast` — 提交 `{ leg, kind, tx }`（`kind`：`claim` | `refund`）以广播
- `POST /swaps/:id/finish` — **watchtower**：提交一份预先签名的 `{ claim: { leg, needsPreimage, tiers:[{feerate,tx}] }, refund: { leg, tx } }`，让协调器在你离线时也能完成该 swap

监视器会在某条已注资、仍未花费的腿的时间锁到期后公开 `refund.{qbit,btc}.available`，
并在某条腿的领取/退款上链（通过 API 或直接上链）时将其标记为 `spent` —— 因此即便一个 swap 在
带外解决，它仍会到达终态。

## Watchtower (`swap.js` `driveWatchtower` + `fees.js`)
一旦两条腿都完成注资，每个对手方便预先签名并上传（`/finish`）一份**费用阶梯领取**（
若干费率档位）和一份**退款**。随后协调器会驱动 swap 走向完成或退款，即使
两个标签页都关闭：它会在腿成熟时广播发起方的领取（揭示原像），
将该原像拼接进参与方预先签名的领取中并广播，或在中止时于对手方的时间锁到期后广播其
退款。它使用缓存的 mempool.space 费率（`fees.js`、`FEES_TTL_MS`）来挑选/升级阶梯档位。
**非托管：**每一笔存储的交易都只支付给其所有者的地址，且协调器不持有任何密钥 —— 它只能协助，绝不能改向。
全 RBF 是网络的默认设置，因此各档位无需 RBF 信号。由 `../webapp/test/watchtower.e2e.mjs` 证明（
双方装填、关闭各自的标签页、协调器完成收尾）。

## Order book API (optional — `offers.js`)
在 swap 引擎之上的一层做市方/吃单方（web 应用用一个开关将其挡在后面；见其 README）。
- `POST /offers` — 做市方发布一手 `{ giveCoin, giveSats, wantCoin, wantSats }` → `{ id, makerToken }`
- `GET  /offers` — 公开订单簿：`{ asks, bids }`（QBT 以 BTC 计价；ask = 卖出 QBT 换 BTC），最优价在前
- `POST /offers/:id/take` — 从挂单实例化一个 swap（吃单方 = 发起方）→ `{ swapId, takerToken, direction, terms }`
- `GET  /offers/:id?makerToken=…` — 做市方视图，含该笔成交（其 swap 令牌），以便其履约
- `POST /offers/:id/cancel`（做市方令牌）— 撤回一个未成交的挂单

## RFQ API（可选 — `rfq.js`，为 web 应用的即时兑换组件提供流动性）
获授权的做市机器人持续报出双边报价；散户一键按最优实时价格成交。与订单簿（挂出的一手报价）不同，
RFQ 报价必须持续心跳维持：机器人一旦静默，其流动性将在 `RFQ_TTL_MS`（默认 30 秒）后失效，因此组件
绝不会报出无人担保的价格。仅当设置 `RFQ_MAKER_KEYS=name:key,name2:key2` 时启用。价格为 BTC/QBT；
数量为 `qbtSats`；`bid` = 做市方买入 QBT（散户卖出），`ask` = 做市方卖出 QBT。
- `POST /rfq/maker`（请求头 `X-Maker-Key`）— 机器人的完整控制循环：（重新）声明 `{ bid?, ask? }`
 （出现的一侧被替换，缺席的一侧沿用——`{}` 为纯保活），刷新 TTL，并接收 `matches`：等待该做市方的
  成交，每条含做市方的 swap 令牌与角色。成交在做市方加入该 swap 之前每次心跳重复投递（无需确认协
  议），随后像任何一方一样通过常规的单笔 swap API 履约。完整参考机器人见 `../maker-bot/`（双边报价、
  库存感知规模、钱包适配器）；`webapp/deploy/rfq-maker-trial.js` 是一个最小的 regtest 实验变体。
- `GET  /rfq` — 公开深度：每侧最优价与总量（未配置做市方时 `enabled:false`）
- `GET  /rfq/quote?side=buy|sell&btcSats=|qbtSats=` — 指定数量下的最优单一做市方成交（取整始终有利
  于做市方）；实时流动性不足时返回 `409`
- `POST /rfq/take` `{ side, btcSats|qbtSats, price }` — 限价语义：以 `price` 或更优成交，否则返回
  `409`「价格已变动」并附新报价。创建 swap → `{ swapId, token, role, terms }`（散户买入 → 吃单方 =
  alice/发起方；散户卖出 → 吃单方 = bob，由做市方发起）。
- `GET  /rfq/plan?side&btcSats|qbtSats` — **多做市商**路由：当单个做市商无法满足某数量时，按最优价优先
  遍历订单簿进行拆单。返回成交量加权 `price` 与逐笔明细；深度不足时返回部分成交（`complete:false`）。
  低于最小值的余量将被丢弃，而非生成粉尘 swap。
- `POST /rfq/order` `{ side, btcSats|qbtSats, price }` — 接受方案，按聚合（VWAP）限价校验。在同一
  `orderId` 下为每一笔腿各开一个 swap → `{ orderId, price, qbtSats, btcSats, legs:[{ swapId, token,
  role, terms }] }`。各腿为**相互独立**的 swap（各自完成或退款，因此可能出现部分成交）；吃单方像处理
  任意 `/rfq/take` swap 一样分别驱动每一笔腿。

RFQ 手续费由**吃单方承担**（点对点链接兑换保持买方承担的加收结构）：买入本来就由吃单方支付（其为
BTC 发送方，充值 `terms + fee`）；卖出则将吃单方的 BTC 所得按净额报价（`takerNetOfGross`），因此
做市方的总支出恰好等于其报价 × 数量。

**信誉 / 成交率。** 协调器无法锁定做市方的资金，因此改为观察其实际行为：在其*已具备充值条件*的匹配
中，有多少次真正充值了自己那一条腿。归因是区分责任的——若吃单方自己都未先充值其首条腿，则不计入
做市方（买入时，在吃单方的 BTC 埋足确认前，做市方本就无法充值）。在 `RFQ_REP_WINDOW_MS` 时间窗内
达到 `RFQ_REP_SUSPEND` 次未履约的做市方将被自动暂停（其报价停止对外提供），直至这些不良记录随时间
淡出。各做市方的统计（`fillRate`、`noShow`、`suspended` 等）显示在管理总览的 `rfq` 部分。可调参数：
`RFQ_REP_GRACE_MS`（15 分钟——已具备充值条件但未充值多久后计为未履约）、`RFQ_REP_WINDOW_MS`（1 小时）、
`RFQ_REP_SUSPEND`（3；设为 0 可禁用）。

## 链对配置（`chains.js`）——第二条腿可配置
引擎有两个链槽位：`btc` 与第二槽位（线上名称 `qbit`），后者可以是**任何兼容 Bitcoin Core RPC 的
UTXO 链**。一个环境变量选择预设：

- `CHAIN2=qbit`（默认——行为与此前完全一致）：p2mr/SLH-DSA HTLC、`conftarget-rpc` 重组模型。
- `CHAIN2=bip110`：**BTC ⇄ BTC/Blake2b 分叉**对（Bitcoin Knots v29.4.x 谱系，BIP-110 已激活）。
  标准比特币脚本 → **两条腿均为 P2WSH + ECDSA HTLC**，两侧均为 `bc` 地址，`fixed` 重组模型
  （Blake2b 算力无法按补贴定价；`ALT_FIXED_CONFS`，默认 12），且 **BTC 侧默认开启重放保护**（见下）。
  将 `QBIT_RPC_URL` 指向分叉节点即可。

所有预设参数均可用环境变量覆盖（`ALT_*`；旧的 `QBIT_*` 仍然有效）。`validateChains()` 在配置错误时
拒绝启动；公共端点 `GET /chains` 告知客户端每条腿的身份，swap 视图也携带 `chains` 字段。

**重放保护**（`*_REPLAY_OPRETURN`）：分叉双链共享分叉前历史，清扫交易可能在两条链上重放。被标记的
腿上，每笔清扫必须携带 **载荷超过 83 字节的 OP_RETURN** —— BIP-110（数据载体限制本身）使此类交易
无法在分叉链上转发/打包，从而将清扫固定在 Core 一侧。协调器在 `broadcast` 与守望塔 `finish` 包上
**强制执行**；客户端库负责构造（`btcSpend({ replay: true })`）。分叉侧没有对应的标记技巧（分叉链
本身限制数据载体）：在其可选的 `SIGHASH_UNIFIED` 客户端稳定之前，**请用分叉后（已分离）的币为分叉
腿充值**，使充值链无法镜像。

**信任未确认**（`BTC_TRUST_UNCONFIRMED` / `ALT_TRUST_UNCONFIRMED`）：将该腿上 0 确认的内存池存款
视为最终——可认领门、顺序充值门与广播保留门在 0 确认即放行，兑换可在任何确认之前完成清扫。
**对恶意对手方不安全**（未确认交易可被 RBF/双花）；仅适用于受信任场景——两侧都是你自己的做市方、
演示环境，或愿以内存池风险换取速度的分叉对。

## Backends (env, per chain — see `chain.js`)
每条链通过 `<CHAIN>_BACKEND` 选择一个后端（回退到 `COORD_CHAIN`，再回退到 `dev`）：
- **`dev`** — 调用某个节点的命令行工具。设置 `<CHAIN>_CLI`，若要远程运行还需设置 `<CHAIN>_SSH_HOST`
  （留空 = 本地）。这是回归测试网实验室的传输方式；`findOutput` 使用 `scantxoutset`（仅在
  极小的回归测试网 UTXO 集上才可行）。
- **`rpc`** — 基于 HTTP 的 JSON-RPC；设置 `<CHAIN>_RPC_URL`（例如 `http://user:pass@host:port`）。注资
  监视方法按链通过 `<CHAIN>_WATCH` 设定（默认：BTC `wallet`，QBT `scan`）：
  - `wallet`（Bitcoin 默认）— 一个**只向前推进的只读钱包**（`importdescriptors timestamp:"now"`
    + `listunspent`），从不使用 `scantxoutset`，因此可在**修剪**的 Bitcoin 节点上工作（`getTx` 通过
    钱包读取，无需 `txindex`）。
  - `scan`（Qbit 默认）— `scantxoutset`，在小型 UTXO 集上很廉价（Qbit 的年轻链），并
    避免依赖钱包对 `p2mr`（witness-v2）描述符的跟踪。反正一个完整（未修剪）的 qbitd 也很
    廉价，因为整条链都很小。
  wallet 路径会运行一个后台作业，轮换钱包以丢弃已结清 swap 的描述符，使其
  不会膨胀
  —— **由数量驱动，而非由时间驱动**：只有在 `WATCH_PRUNE_THRESHOLD`（默认 500）个陈旧
  描述符摊销之后才轮换一次（几百个是无害的），每隔 `WATCH_CLEANUP_MS`（默认 6h）检查一次。
  一个描述符在其 swap 仍非终态期间（**整个恢复/退款窗口**，可能很长）会一直保留，
  外加结清后一段 `WATCH_SETTLE_GRACE_MS` 的宽限期（默认 24h），因此当对手方可能仍在
  退款时它绝不会被丢弃。（即便真被丢弃，资金也绝不会有风险 —— 该钱包仅用于注资*检测*；
  各方用自己的密钥退款。）`WATCH_WALLET` 设定钱包名称。
- **`esplora`** — 用于 **BTC 腿**的 mempool.space / 自托管 electrs REST（无需 Bitcoin 节点）；
  设置 `ESPLORA_URL`（默认 `https://mempool.space/api`）。带索引的 scripthash 查询 + 内置的
  限流处理（`ESPLORA_MIN_INTERVAL_MS`、`ESPLORA_MAX_RETRIES`）。Qbit 没有公开后端，因此
  QBT 腿必须针对你自己的 `qbitd` 使用 `dev`/`rpc`。

其他可调项：`COORD_DB=/path/state.db`（通过 `node:sqlite` 的 **sqlite** 持久化——每个 swap 一行，按变更
UPSERT，因此 `touch()` 为 O(1)，而非整文件重写；swap 以 JSON 列存储，可用 JSON1 查询：
`SELECT id FROM swaps WHERE json_extract(data,'$.state')='COMPLETE'`。`.json` 路径则使用旧的原子快照后端；
空的 `.db` 若旁边存在 `.json` 会在首次启动时导入。默认：内存中，不持久化。`/api/overview` 的
`persistence` 字段显示当前后端。）· `RATE_MAX=120`
（每 IP 每分钟写入数）· `DEV_CONFS_CAP`（在没有算力的回归测试网上封顶抗重组确认门槛）。

### HTLC addresses + timelocks (set these for the deploy network)
- `BTC_HRP` / `QBIT_HRP` — 协调器发放的 HTLC **存款地址**的 hrp。必须与
  网络匹配：`bcrt`/`qbrt`（回归测试网，默认）、`tb`/`tqb`（测试网）、`bc`/`qb`（主网）。hrp 错误 =
  一个用户钱包无法支付的地址。
- **时间锁是挂钟时间**，而非原始区块数。`HTLC_FROM_SECS`（发起方的腿，较长；默认 24h）
  和 `HTLC_TO_SECS`（参与方的腿，较短；默认 12h）各自通过 `BTC_BLOCK_SECS`（600）/ `QBIT_BLOCK_SECS`（60）
  在各自的链上换算为一个区块数。这使得 Tier-Nolan 的排序（发起方的腿在真实时间上比参与方的腿更长久）
  在**两个**方向上都保持正确，尽管 BTC 约 10 分钟而 QBT 约 60 秒出块。`HTLC_FROM_SECS` 必须大于 `HTLC_TO_SECS`（强制约束）。
  对于快速的回归测试网实验室，将出块时间设为 `1`，窗口设为 `20`/`40`（见 `deploy/lab.env`）。

## Run the demos
需要两个回归测试网节点处于运行状态（见 `../wasm`/`../js`）。然后：
```sh
DEV_CONFS_CAP=2 node demo.js         # happy path: full swap -> COMPLETE
DEV_CONFS_CAP=2 node refund_demo.js  # abort path: both parties refund -> REFUNDED, no preimage
```
`demo.js` 创建一个 swap，两个 bot 都加入，为两个 HTLC 注资，让 QBT 腿成熟，Alice 领取 QBT
（WASM SLH-DSA，揭示原像），Bob 读取它并领取 BTC。`refund_demo.js` 为两条腿注资
然后停滞；一旦时间锁到期，Bob 退款其 QBT，Alice 退款其 BTC —— 证明了
非托管的中止保证（无人会吃亏）。

## Not yet (next)
- 构建在 `../js` 之上的浏览器 web 应用（文件备份 + 用 passkey-PRF/密码加密的 IndexedDB 密钥
  管理）；抗重组的高度跟踪已经在为监视器供数。
