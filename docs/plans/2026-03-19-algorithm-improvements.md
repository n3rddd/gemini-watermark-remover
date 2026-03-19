# 算法改进记录与推进顺序

> 状态文档。用于沉淀本仓库当前水印去除算法的结构判断、真实瓶颈、优先级排序，以及后续推进过程中的决策依据。

## 当前算法主链

当前实现的核心路径不是“先检测，再处理”，而是：

1. 基于官方尺寸目录、默认锚点和近官方尺寸投影生成标准候选。
2. 对候选执行真实逆混合。
3. 用恢复后的残留相关性、梯度变化、近黑比例变化再次验证候选是否可信。
4. 必要时追加模板形变、alpha gain、多轮剥离和子像素轮廓微调。

这条路径比固定 `48/96 + 默认锚点 + 一次逆混合` 更稳，也解释了为什么当前实现能覆盖：

- 近官方尺寸缩放图
- 锚点轻微漂移图
- 部分需要多轮剥离的样本
- 需要恢复后再反向确认归因的边界图

## 现有优势

- 候选不是只靠原图相关性决定，而是要经过恢复后验证。
- 已经有目录先验，避免纯比例规则过于脆弱。
- 已经有多轮剥离安全阈值，能防止明显的暗坑式过修复。
- 已经把 `decisionTier` 和 UI/归因逻辑打通，便于产品层使用。

## 真正有价值的改进项

### P0. 把 adaptive 搜索改成真正的延迟 fallback

当前问题：

- `selectInitialCandidate()` 在 `allowAdaptiveSearch=true` 时会直接跑 adaptive 搜索。
- 仓库里已有 `shouldAttemptAdaptiveFallback()`，但它没有接入主路径。
- 这导致 adaptive 搜索过早介入，增加计算成本，也扩大了弱证据候选的参与范围。

目标：

- 先跑标准候选、目录投影、局部标准补偿。
- 只有当标准路径恢复后残留仍高、原始位置明显错位，或标准候选无法建立可信结果时，才进入 adaptive 搜索。

预期收益：

- 降低主路径成本。
- 减少不必要的 adaptive 误触发。
- 更符合“标准优先，复杂回退延后”的工程结构。

### P1. 把局部纹理一致性前移到候选验收

当前问题：

- 候选验收主要依赖 suppression、gradient increase、near-black increase。
- 更强的局部亮度/纹理保护主要在 multi-pass 阶段。
- 这意味着首轮候选仍可能接受数值上看似有效、视觉上却不自然的方案。

目标：

- 在 `evaluateRestorationCandidate()` 阶段引入局部参考区统计。
- 让错误候选更早被淘汰，而不是等到 multi-pass 再补救。

### P1. 在标准路径和 full adaptive 之间插入便宜的 size jitter

当前问题：

- `searchNearbyStandardCandidate()` 只做位置平移，不做小范围尺寸扰动。
- 对“接近官方尺寸但被缩放”的图，容易直接掉到更贵的 adaptive。

目标：

- 在标准候选附近加入小范围 size jitter。
- 作为标准种子和 full adaptive 之间的中间层。

### P2. 增加独立的残留修复层

当前问题：

- 逆混合、多轮剥离、gain、subpixel 已经能解决大部分结构问题。
- 但对缩放、重编码、预览图常见的边缘亮点/闪烁残影，仍缺少独立的视觉收尾层。

目标：

- 新增基于 alpha 梯度掩膜的局部软修复层。
- 第一阶段优先做 deterministic 的 soft inpaint / blur blend。
- 不在第一阶段引入重型 AI 依赖。

### P2. 维护多模板 family，而不是单模板无限变形

当前问题：

- 当前只有嵌入式 `48/96` 两个模板，其他尺寸全部从 `96` 插值而来。
- `warp + gain + subpixel` 主要补位置/尺度/强度误差，对模板风格漂移无能为力。

目标：

- 为不同模板风格或导出路径准备少量模板族。
- 让候选选择发生在模板之间，而不是只在单模板上继续堆补丁。

## 当前不值得优先投入的方向

- 继续增加 `maxPasses`
- 继续扩充 `ALPHA_GAIN_CANDIDATES`
- 再堆一层基于尺寸规则的 if/else
- 只调 magic numbers，不改判定结构

这些改动会增加复杂度，但不会实质改善泛化能力。

## 推进顺序

### 第一阶段

1. 延迟 adaptive fallback
2. 用测试锁定：
   - 标准强匹配时不应急于进入 adaptive
   - 标准路径不足时仍能正确掉入 adaptive
   - 现有 adaptive 样本不回归

### 第二阶段

1. 候选验收前移局部纹理一致性
2. 补 size jitter 中间层

### 第三阶段

1. 独立残留修复层
2. 多模板 family 设计

## 第一阶段实施说明

本次会话先推进 `P0: 延迟 adaptive fallback`。

原因：

- 改动面小，收益明确。
- 与现有结构高度兼容。
- 已经存在可复用的 fallback 判断函数。
- 能为后续 `P1` 和 `P2` 提供更清晰的处理分层。

## 第一阶段落地结果

已完成：

- 在 `selectInitialCandidate()` 中移除 eager adaptive 的默认主路径位置。
- 改为先走标准候选主链，再依据 fallback 条件决定是否进入 adaptive。
- 保留“adaptive 能击败默认锚点”的既有能力。
- 保留现有 `decisionTier` / 归因行为。

新增测试：

- 标准强匹配时，不应因为 eager adaptive 依赖而失败。

已验证通过：

- `tests/core/candidateSelector.test.js`
- `tests/core/watermarkProcessor.test.js`
- `tests/core/adaptiveDetector.test.js`
- `tests/core/watermarkDecisionPolicy.test.js`
- `tests/core/originalValidation.test.js`

当前结论：

- “标准强匹配优先，adaptive 延迟回退”已经成立。
- “局部标准补偿不能阻止 adaptive 参赛”也已保留。

## 下一步建议

下一项建议推进 `P1: 候选验收前移局部纹理一致性`。

原因：

- 当前这部分保护仍主要存在于 multi-pass。
- 前移后可以更早淘汰视觉上不自然的一次候选。
- 能直接减少后续 alpha gain / multi-pass 的补救压力。

## 第二阶段当前进展

已完成一小步前移：

- 在 `evaluateRestorationCandidate()` 中加入局部参考区的亮度/纹理偏差计算。
- 新增显式 `texturePenalty`，并将其并入 `validationCost`。
- 当前实现先做“评分前移”，尚未引入新的硬拒绝条件。

这样做的原因：

- 先把局部参考信息接入候选排序，风险比直接加拒绝阈值更低。
- 先观察成本项是否足以改变候选竞争结果，再决定是否把严重纹理塌陷升级为 reject。

本阶段新增测试覆盖：

- 当候选恢复结果相对局部参考区明显变暗时，应增加 `texturePenalty` 与 `validationCost`。

下一步可选方向：

1. 对“同时明显变暗且明显变平”的候选增加硬拒绝。
2. 把 `texturePenalty` 暴露到更多调试信息中，便于分析真实样本。
3. 推进 `size jitter` 中间层，减少 full adaptive 的触发率。

## 第二阶段进一步落地

已补充：

- 新增 `assessReferenceTextureAlignment()`，把局部参考区亮度/纹理评估显式化。
- 在 `evaluateRestorationCandidate()` 中加入 `tooDark`、`tooFlat`、`hardReject`。
- 对“同时明显变暗且明显变平”的候选执行硬拒绝，而不只是增加成本项。

当前状态：

- 候选验收已经不再只看 suppression / gradient / near-black。
- 局部参考区的一致性已经进入候选 accept/reject 逻辑。
- 核心处理链回归测试仍保持通过。

建议下一步：

- 插入 `size jitter` 中间层，用比 full adaptive 更便宜的方式覆盖默认锚点附近的轻微尺寸漂移。

## 第三阶段当前进展

已完成一版 `size jitter` 中间层：

- 在标准候选层新增小范围尺寸漂移搜索。
- 只在标准候选不属于 `direct-match` 时参与竞争，避免干扰强标准匹配。
- 目标是覆盖默认锚点附近的小尺寸偏移，而不是替代 adaptive。

新增测试覆盖：

- `adaptiveMode: 'never'` 下，默认锚点附近的 `54px` 轻微尺寸漂移样本可以被恢复。

当前收益：

- 对“尺寸轻微漂移但仍贴近默认锚点”的样本，不必再依赖 full adaptive。
- 标准主路径分层更清楚：
  - 强标准匹配
  - 标准尺寸补偿
  - adaptive fallback

当前建议的下一步：

1. 把 `texturePenalty / hardReject / size-jitter` 暴露到调试信息里，便于分析真实样本。
2. 再决定是否加入更大范围的 `local size + local shift` 联合搜索。
3. 如果浏览器侧残留边缘仍明显，再推进独立的 soft inpaint 收尾层。

## 第三阶段后续补充

本轮已完成调试信息外显：

- `processWatermarkImageData()` 返回的 `meta` 新增 `selectionDebug` 摘要。
- 当前暴露字段包括：
  - `candidateSource`
  - `texturePenalty`
  - `tooDark`
  - `tooFlat`
  - `hardReject`
  - `usedSizeJitter`

这样做的边界：

- 只暴露稳定摘要，不泄漏整个内部 `selectedTrial` 结构。
- 调试信息固定在 core `meta` 层，先不碰扩展诊断 UI，避免和现有页面侧脏改冲突。

新增测试覆盖：

- `processWatermarkImageData` 会在 `meta.selectionDebug` 中暴露候选选择摘要。
- 对 `54px` 默认锚点小尺寸漂移样本，能够明确标记 `usedSizeJitter=true`。

当前结论：

- 算法主链的“判定依据”已经不再只存在于内部候选结构。
- 后续分析真实失败样本时，可以直接从 `meta` 判断是否触发了尺寸漂移补偿，以及候选是否带有明显纹理惩罚。

建议下一步：

1. 把 `selectionDebug` 接到浏览器侧 diagnostics summary。
2. 针对真实失败样本统计 `usedSizeJitter / hardReject / texturePenalty` 分布。
3. 若 size-jitter 命中率继续升高，再评估是否引入更便宜的“size + local shift”联合搜索层。

## 复用性收口

本轮已完成一项工程性收口：

- 新增共享模块 `src/core/restorationMetrics.js`。
- 将以下能力从重复实现收敛为单一来源：
  - `cloneImageData`
  - `calculateNearBlackRatio`
  - `scoreRegion`
  - `assessReferenceTextureAlignment`

已完成的替换：

- `candidateSelector` 改为直接复用共享恢复度量模块。
- `multiPassRemoval` 改为直接复用同一套区域评分与纹理塌陷判定逻辑。

新增测试覆盖：

- `restorationMetrics` 的深拷贝、近黑比例、纹理塌陷判定。
- `multiPassRemoval` 对 `safety-texture-collapse` 的独立回归测试。

当前收益：

- 候选选择与 multi-pass 安全保护不再维护两套局部纹理规则。
- 后续如果调整纹理惩罚或硬拒绝条件，只需要改一处。

当前仍保留的后续项：

1. `watermarkProcessor` 测试文件仍有较多重复 setup，可在下一轮收敛测试夹具。

## provenance 结构化

本轮已继续收口调试来源建模：

- 新增 `src/core/selectionDebug.js`，集中生成 `selectionDebug` 摘要。
- `candidateSelector` 内的候选现在开始显式携带 `provenance`。
- 当前已接入的结构化来源包括：
  - `sizeJitter`
  - `localShift`
  - `catalogVariant`
  - `adaptive`

已完成的行为收口：

- `selectionDebug.usedSizeJitter` 不再通过解析 `source` 字符串判断。
- 改为只读取候选的结构化 `provenance.sizeJitter`。

新增测试覆盖：

- `selectionDebug` 摘要优先使用结构化 provenance。
- 即使 `source` 文本里包含 `+size`，如果 provenance 未标记，也不会误报 `usedSizeJitter=true`。
- `selectInitialCandidate` 对 size-jitter 命中的候选会显式带上 `provenance.sizeJitter=true`。

当前收益：

- 调试摘要不再依赖隐式字符串协议。
- 后续若调整 `source` trace 文本，不会静默污染诊断结果。

## 样本 benchmark 基线

本轮已开始把“真实样本分析”从回归测试中独立出来：

- 新增脚本 `scripts/sample-benchmark.js`
- 新增脚本单测 `tests/scripts/sampleBenchmark.test.js`
- 新增包脚本：
  - `pnpm benchmark:samples`

当前脚本能力：

- 读取 `src/assets/samples` 中已知 Gemini / 非 Gemini 样本
- 通过 Playwright 解码图像
- 在 Node 侧直接复用生产 `processWatermarkImageData()` 跑处理
- 输出结构化 JSON 报告到 `.artifacts/sample-benchmark/latest.json`
- 按失败类型分桶：
  - `missed-detection`
  - `weak-suppression`
  - `residual-edge`
  - `attribution-mismatch`
  - `false-positive`

第一轮实测结果：

- 总样本数：`9`
- 通过：`8`
- 失败：`1`
- 当前唯一失败桶：`residual-edge`
- 当前唯一失败样本：`5.png`

这轮 benchmark 给出的结论：

- 当前主链不是“普遍检不出”。
- 当前更值得投入的不是继续扩 detection/search，而是优先解决 `5.png` 这一类“检测成立、 suppression 也不低，但残留边缘仍明显”的样本。
- 这直接支持把下一阶段重点转到“独立残留修复层”。

已额外落出专项研究文档：

- `docs/plans/2026-03-19-5png-residual-repair-plan.md`

## 5.png residual repair 决策回收

本轮对 `5.png` 的 `edge-repair` 支线做过一次主链接入验证：

- 路径是 `soft reference blend`
- 目标是降低 `safety-near-black` 截停后的边缘残影
- 实测可以把 `processedSpatialScore` 从 `0.4207` 拉到 `0.3603`

但最终没有保留到主链，原因很直接：

- benchmark 没有发生状态跃迁，仍是 `8/9`
- `5.png` 仍然落在 `residual-edge`
- 这条支线增加了额外分支、阈值与维护成本
- 收益不足以覆盖主链复杂度上升

因此当前收口结论是：

- 保留研究文档和 benchmark 分析
- 不保留 `edge-repair` 的生产实现
- `5.png` 继续作为已知 hard case 跟踪
- 主链继续优先保持简单、稳定、可解释

## 验收标准

- 现有 `watermarkProcessor` 与 `adaptiveDetector` 核心测试保持通过。
- 新增测试能证明：
  - 标准候选足够强时，不需要 eager adaptive。
  - 标准路径不足时，adaptive 仍能介入并产生正确结果。
- 不修改与当前任务无关的扩展页面逻辑文件。
