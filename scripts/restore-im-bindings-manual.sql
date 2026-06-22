-- 第二批回填：恢复 5 个"手动 /new 工作区"的 admin 飞书群 target_main_jid。
--
-- 与第一批(restore-im-bindings.sql，13 群)的区别：这 5 群均在 v37(4/24)备份之后
-- 用 /new 创建独立工作区，故备份中无指针可依。配对依据（高置信度）：
--   * 每个飞书群的 registered_groups.added_at 与对应工作区主群 added_at 仅相隔
--     6~24 秒——同一次 /new 操作（先自动注册群、再创建并绑定工作区）的注册序列；
--   * 工作区名（main-codex/克己录/北京炒房/kaboo/opus47）为用户显式命名；
--   * 这 5 个飞书群当前 target_main_jid 均为空；目标工作区在各自 folder 内唯一。
--
-- 安全性：幂等（WHERE 限定 target_main_jid IS NULL OR ''，已绑定行不覆盖；重跑不变）。
-- 使用前停服 + 备份（参见 restore-im-bindings.sql 头部）。

BEGIN TRANSACTION;

-- oc_4bd48 (2026-04-26 11:37:41) → main-codex / flow-mofp2b3k-irne (工作区 +15s)
UPDATE registered_groups SET target_main_jid='web:bd4be75a-899b-46dd-87b5-5818f9ace450'
  WHERE jid='feishu:oc_4bd4809ab0d11e0aea9afdf4aa435f3a' AND (target_main_jid IS NULL OR target_main_jid='');
-- oc_6b13e4 (2026-04-28 10:28:11) → 克己录 / flow-moihggdj-q06g (+7s)
UPDATE registered_groups SET target_main_jid='web:6ac6f7c9-2412-4280-bf69-e2df00ce5b23'
  WHERE jid='feishu:oc_6b13e4e5cae092f142c1b6ac1bec7d4a' AND (target_main_jid IS NULL OR target_main_jid='');
-- oc_be696 (2026-05-05 07:16:24) → 北京炒房 / flow-mosap5ij-38l2 (+24s)
UPDATE registered_groups SET target_main_jid='web:6fb300eb-35d4-4b46-96d0-fd9e55276a33'
  WHERE jid='feishu:oc_be6967845d65d649188e51e6e182a341' AND (target_main_jid IS NULL OR target_main_jid='');
-- oc_2e1ba (2026-05-07 01:24:26) → kaboo / flow-mouszttt-x481 (+6s)
UPDATE registered_groups SET target_main_jid='web:8e905b5c-8ca2-4071-a2ea-33483df7524c'
  WHERE jid='feishu:oc_2e1baa2a8e2a88160441852aada28a73' AND (target_main_jid IS NULL OR target_main_jid='');
-- oc_7a515 (2026-05-12 06:32:52) → opus47 / flow-mp297wji-blnt (+14s)
UPDATE registered_groups SET target_main_jid='web:28584cac-30d9-4580-886e-9244f1859d12'
  WHERE jid='feishu:oc_7a515b5b836551c8f88842665d343238' AND (target_main_jid IS NULL OR target_main_jid='');

COMMIT;
