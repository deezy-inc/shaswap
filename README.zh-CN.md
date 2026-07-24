[English](README.md) · **简体中文**

# qbit-swap

[![CI](https://github.com/deezy-inc/qbit-swap/actions/workflows/ci.yml/badge.svg)](https://github.com/deezy-inc/qbit-swap/actions/workflows/ci.yml)

在 **Bitcoin (BTC)** 与 **Qbit (QBT)** 之间进行非托管原子兑换——Qbit 是一个后量子的比特币分叉
（SLH-DSA 签名、`p2mr` 见证 v2 地址）。用户通过一个**无密钥协调器**进行点对点交易：所有密钥都是临时密钥，
并在用户的浏览器中生成，所有签名都在客户端完成，协调器只监视链并转发由各方签名的交易。它不持有任何
密钥，也无法独自转移资金；停滞的兑换总是会退款。（仍存在一项信任假设——需要依赖它诚实地转发各方的
公钥；参见 `webapp/README.md` › Trust assumptions。）

> Bitcoin ↔ Qbit 无法使用共享 Schnorr 构造（Qbit 使用 SLH-DSA 签名，而非 Schnorr），因此
> 本方案采用经典的哈希时间锁（Tier-Nolan）原子兑换：一个 preimage 关联两条腿。

## 仓库布局

| Path | What it is | Public |
|---|---|---|
| `client/` | **客户端库**（`@qbit-swap/client`）——为两条腿构造 HTLC + sighash + 签名；支持浏览器 + Node。内置 WASM SLH-DSA 签名器。 | ✅ |
| `coordinator/` | **无密钥协调器**——Tier-Nolan 状态机、抗重组的确认门控、退款旁路、SSE 实时推送、在线状态、可插拔的链后端。 | ✅ |
| `webapp/` | **Web 应用**——一个与钱包无关、每屏一个决策的向导（EN / 简体中文）。临时密钥、页内签名、明文备份文件。 | ✅ |
| `maker-bot/` | **做市机器人**——RFQ 即时兑换 API 的参考做市实现：持续报出双边报价、以任一角色履约成交、库存感知的报价规模、可插拔的钱包适配器。 | ✅ |
| `reference/*.py` | Python 参考实现 + 回归测试网验证脚本。 | ✅ |

## 兑换的工作原理

1. 任意一方打开 Web 应用并选择方向（BTC→QBT 或 QBT→BTC）。**发起方**持有一个
   密钥 `s`，满足 `H = SHA256(s)`。
2. 两条腿都被资助到根据 `H` 和双方公钥派生出的 HTLC 地址。
   发起方资助它发送的那条腿（较长的时间锁）；参与方资助另一条（较短的）。
3. 发起方领取它接收的那条腿，从而在链上揭示 `s`。参与方读取 `s` 并
   领取另一条腿。如果任意一方停滞超过时间锁，则各自退款自己的存款。

协调器通过 Qbit 的 `getconfirmationtarget` RPC，将发起方的领取门控在**抗重组的确认数**上，
并通过 SSE 推送呈现 preimage 与可退款性。

默认体验是**点对点**的（与对手方分享一个私密链接）。还有一个可选的
maker/taker **订单簿**——做市方发布报价，接单方点击买入/卖出——它位于 Web 应用的一个
功能开关之后（`window.QBIT_ORDERBOOK`，默认关闭），协调器端由 `offers.js` 提供支持。

## 看守塔——在某一方离线时完成兑换

原子兑换有一个硬性要求：一旦发起方揭示 `s`，参与方**必须**在其时间锁之前
领取，否则发起方可能退款并同时拿走两侧。因此在错误的时刻关闭标签页的一方可能会蒙受损失。看守塔在**不进行
任何托管**的情况下消除了这一风险。

**关键洞察：**对领取/退款交易的签名**并不**覆盖 preimage——preimage 是脚本在花费时校验的
一个单独的见证元素。因此这些交易可以被*预先签名*，并交给一个只能将它们完成**到该方自己地址**的看守塔。

一旦两条腿都被资助，每个浏览器会自动预签名并上传（`POST /swaps/:id/finish`）：

- 它接收的那条腿的一个**费率阶梯领取**——按递增费率分为若干档（参与方以*无 preimage*
  的方式签名，留一个空槽由协调器在 `s` 公开后填充）；以及
- 它资助的那条腿的一个**退款**。

随后协调器（`swap.js` 的 `driveWatchtower` + `fees.js`）**仅为一个确实已经
离线的一方**行动（依据在线状态，约 15 秒宽限，因此绝不会与在线客户端抢跑）：它在腿成熟时广播发起方的
领取（揭示 `s`），将 `s` 拼接进参与方的预签名领取并广播它，或在中止时于时间锁之后广播一笔退款。它使用
缓存的 **mempool.space** 费率来挑选/升级阶梯档位（full-RBF 是网络默认，因此无需 RBF 信令）。

**非托管：**每一笔存储的交易都已签名为只支付其所有者的地址，且协调器
不持有任何密钥——它最坏也只能不去帮忙，而绝不能重定向资金。当双方都已武装完毕时，一笔兑换会在**无人打开
标签页**的情况下运行至完成或退款。Web 应用要求先完成这一预签名，然后才会告诉你可以安全地关闭
（`webapp/README.md`）；在 `webapp/test/watchtower.e2e.mjs` 中已端到端验证。

## 后端（你需要哪些基础设施）

协调器只做链上**读取 + 广播**（它是无密钥的）。每条链通过环境变量选择一个后端——参见
`coordinator/chain.js`：

- **Qbit——必需：你自己的 `qbitd`。**没有公共的 Qbit 后端，而抗重组的确认门控
  是一个 `qbitd` RPC。使用 `QBIT_BACKEND=rpc` + `QBIT_RPC_URL=...`。
- **Bitcoin——三种选项：**

  | `BTC_BACKEND` | Node | Disk | Rough $/mo (AWS) | Notes |
  |---|---|---|---|---|
  | `rpc`（watch-only 钱包） | **修剪节点** Bitcoin Core | ~30–50 GB | **~$110–180** | 最便宜；仅向前的地址监视；从不使用 `scantxoutset` |
  | `esplora` → `mempool.space` | 无 | 0 | **$0** | 启动最快；有速率限制 + 会泄露被监视的地址 |
  | `esplora` → 自托管 electrs | **全节点** Core + electrs | ~2 TB | ~$265–450 | 功能最丰富；负担最重（esplora REST 索引很大） |

  `esplora` 后端包含速率限制处理（最小间隔节流 + 429/5xx 退避），并
  可对任意 Esplora REST 端点工作（`ESPLORA_URL`）。`rpc` 后端使用一个 **watch-only
  钱包**（仅向前导入每个 HTLC 地址）——从不使用 `scantxoutset`，因为它会重扫整个
  UTXO 集，在主网上无法使用。

  **推荐：**从 `mempool.space`（免费）起步，为节省成本转到**修剪节点 + `rpc`**，或
  在你希望拥有 REST API 且不依赖任何第三方时自托管 electrs。请让节点主机保持**私有**，
  与公共协调器（它是攻击面）分离。

## 运行它（回归测试网）

每个组件都有自己的 README：
- `client/README.md` — 客户端库 + 浏览器/Node 签名器、测试。
- `coordinator/README.md` — API、状态机、后端、演示（`demo.js`、`refund_demo.js`）。
- `webapp/README.md` — 构建应用、运行向导 e2e、试用部署。

一个本地回归测试网实验室通过环境变量（`<CHAIN>_CLI`、可选的 `<CHAIN>_SSH_HOST`）驱动传输层；代码中
不写死任何主机名。

## 许可证

MIT——参见 [LICENSE](LICENSE)。
