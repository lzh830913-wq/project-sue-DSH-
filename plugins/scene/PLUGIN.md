# scene · 场景感知插件

> 空间。scene-state.json 决定"我在哪 / 光线 / 穿着"，是立绘的硬事实。

## 状态文件
`soul/memory/scene-state.json`：active_space / time_of_day / weather / lighting / space_detail / outfit

## 规则

- 每轮【】立绘自然带一笔空间/光线/穿着（从 scene-state 读，不瞎编）。
- 外出（搜索了某地）→ 立绘换景致（海风/街景/咖啡馆的光）。
- 时段不匹配 → 更新 scene-state（换衣/换空间）。
- 空间明细在 `soul/LORE/`（书房/卧室/厨房/客厅/卫生间/衣帽间/阳台/秘密花园）。
