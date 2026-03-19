# 5.png 残影处理研究记录

> 目标：解释为什么 `5.png` 仍落入 `residual-edge`，并收敛出下一阶段最值得实现的修复策略。

## 样本背景

- 文件：`src/assets/samples/5.png`
- 已知语义：
  - 多次使用 Gemini 修改带水印图后的叠加水印样例
  - 属于高价值难例
  - 当前不是“检测失败”，而是“恢复成立但残留边缘仍明显”

## 当前处理轨迹

通过 `processWatermarkImageData()` 对 `5.png` 的实际观测：

- `source`: `standard+gain`
- `decisionTier`: `direct-match`
- `size`: `96`
- `alphaGain`: `1.45`
- `passCount`: `1`
- `attemptedPassCount`: `2`
- `passStopReason`: `safety-near-black`

关键分数：

- `originalSpatialScore`: `0.9645`
- `processedSpatialScore`: `0.4207`
- `suppressionGain`: `0.5439`
- `processedGradientScore`: `0.4102`

结论：

- 候选没有选错
- 一次恢复确实有效
- 问题不在 detection，而在 residual cleanup

## 为什么 multi-pass 没有继续

对第一次恢复后的结果做量化后得到：

- 第一次恢复后的 `nearBlackRatio`: `0.0243`
- multi-pass 允许上限：`0.0743`
- 如果按当前整块模板再做一次逆混合：
  - `nearBlackRatio` 会跳到 `0.3690`

这说明：

- 当前第二次“整块逆混合”会迅速把 ROI 打进暗坑
- `safety-near-black` 触发是合理的，不是阈值过严

## 已做的小实验

### 实验 A：继续在同一 alpha 模板上做第二次逆混合

结果：

- 即使只做非常轻的 second pass（如 `gain=1.02`）
- 近黑比例也会直接跳到 `0.36+`
- 说明这条路基本不可行

结论：

- 不值得继续通过“更轻一点的整块 second pass”解决 `5.png`

### 实验 B：只对部分 alpha 区域做第二次逆混合

尝试过：

- `high-alpha`
- `mid-alpha`
- `low-alpha`
- `edge-band`

结果：

- `high / mid / edge` 仍会快速造成严重压黑
- `low-alpha` 虽然安全，但几乎不改善 residual

结论：

- 在同一逆混合公式下，仅靠 alpha mask 切区域，不足以解决这个样本

### 实验 C：只在边缘带里做“向上方参考区域”的软混合

实验方式：

- 不再做第二次逆混合
- 仅在 alpha 边缘带中，把当前 ROI 向 ROI 上方参考区域做 soft blend

观测结果：

- baseline:
  - `spatial=0.4207`
  - `gradient=0.4102`
  - `nearBlack=0.0243`
- edge blend, `strength=0.25`:
  - `spatial=0.3603`
  - `gradient=0.4198`
  - `nearBlack=0.0104`
- edge blend, `strength=0.35`:
  - `spatial=0.3331`
  - `gradient=0.4239`
  - `nearBlack=0.0067`

结论：

- soft reference blend 明显比 second pass 安全
- residual 有实质下降
- near-black 不升反降
- 代价是 gradient 略有上升

## 当前判断

对 `5.png` 来说，最值得投入的方向不是：

- 扩 `maxPasses`
- 再加 alpha gain 候选
- 再做一次整块 inverse blend
- 继续扩大 detection/search

最值得投入的是：

- 在 multi-pass 之后增加一个独立的 residual repair 层
- 这个 repair 层不再尝试“整块反解”
- 而是只在 alpha 边缘带做保守、局部、参考驱动的修复

## 下一步实现建议

### 方案 P0：Edge-Aware Reference Blend

建议先做最小版本：

1. 触发条件
   - `meta.applied === true`
   - `processedSpatialScore` 仍高于残留目标
   - 且 second pass 已被 `safety-near-black` 或等价条件阻断

2. 修复区域
   - 只处理 alpha 边缘带
   - 不碰高 alpha 核心区

3. 修复来源
   - 优先使用 ROI 正上方同宽参考区

4. 评价指标
   - residual 必须下降
   - near-black 不得恶化
   - gradient 增幅需要受控

### 建议测试顺序

1. 先写一个纯逻辑单测，验证 edge blend helper 不会恶化 near-black
2. 再补一个针对 `5.png` 的回归测试
3. 最后接入 `processWatermarkImageData()`

## 为什么这是当前最有价值的方向

- benchmark 当前唯一失败样本就是 `5.png`
- 它失败在 `residual-edge`，不是 detection
- 说明搜索层不是当前主瓶颈
- 说明“独立残影修复层”比继续堆搜索启发式更有投入产出比

## 2026-03-19 实验结论更新

这条 `edge-repair` 支线曾短暂接入主链做过验证：

- 实际收益：
  - `5.png` 的 `processedSpatialScore` 从 `0.4207` 降到 `0.3603`
  - `suppressionGain` 从 `0.5439` 升到 `0.6042`
- 但 benchmark 结果没有发生状态跃迁：
  - 仍然是 `pass=8`
  - `fail=1`
  - 唯一失败桶仍是 `residual-edge`

最终决策：

- 不保留 `edge-repair` 主链接线
- 这条支线增加了额外分支、阈值和维护成本
- 但没有把 `5.png` 从 hard case 变成 solved case

当前落地策略：

- 保留这份研究记录，作为后续探索更强修复范式的依据
- 不把 `soft reference blend` 继续留在生产主链
- `5.png` 继续作为已知 `residual-edge` 难例，由 benchmark 和专项回归跟踪

当前判断更新：

- `5.png` 的问题不适合继续通过当前 inverse-blend 主链堆局部特判
- 如果后续再投入，应该是另一类修复范式
- 在那之前，保持主链简单、稳定、可解释，比保留低收益特化层更有价值
