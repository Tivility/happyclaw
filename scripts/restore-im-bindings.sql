-- 回填本次"IM 绑定健康检查串台事故"被清空的 admin 飞书群 target_main_jid。
--
-- 背景：feishu.ts getChatInfo 把"飞书 token 接口/网络故障"与"群真失效"都 catch 成
-- 同一个 null，一次 token 接口抖动(EADDRNOTAVAIL)让所有 bound 群批量返回 null → 跨阈值
-- → 逐群 unbind 清空 target_main_jid → 全部串台。本脚本按 v37 备份回填这 13 个指针。
--
-- 安全性：
--   * 幂等 —— WHERE 子句限定 (target_main_jid IS NULL OR target_main_jid='')，
--     已有非空指针的行不会被覆盖；重跑结果不变。
--   * 仅回填 v37 备份中 created_by=admin 且 target_main_jid 非空的 13 个飞书群。
--   * 5~6 个无 v37 指针的手动群（main-codex/克己录/北京炒房/kaboo/opus47 等，
--     folder=main）不在此脚本内，需人工确认配对后另行处理。
--
-- 使用前务必先在备份副本上 dry-run：
--   cp data/db/messages.db /tmp/restore-dryrun.db   # 或用 sqlite3 .backup（含 WAL）
--   sqlite3 /tmp/restore-dryrun.db < scripts/restore-im-bindings.sql
-- 校验无误后再对生产库执行（建议停服 + 备份后操作）。

BEGIN TRANSACTION;

UPDATE registered_groups SET target_main_jid='web:b7e3c1d2-4f5a-4e6b-8c9d-0a1b2c3d4e5f'
  WHERE jid='feishu:oc_252424d3695986670083c6e85a85bf48' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:33db7262-eed0-448b-b859-3ac553b1515a'
  WHERE jid='feishu:oc_481ed70032175085cc031895fefd77c7' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:c0f35d64-3231-466f-9855-02fa6d37d89b'
  WHERE jid='feishu:oc_76a116c21c6bab552ec0217b4e94af68' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:abbd1e1a-4046-4035-ba8f-1c90cc04e1fc'
  WHERE jid='feishu:oc_991e25a9166485f173a3c0983c2b8748' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:cf02a74d-5067-4e35-945d-d012e9de9a99'
  WHERE jid='feishu:oc_9dbf746cd02abcb43cab1945c803f6ef' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:73ee53bc-9bdc-4858-b403-da8e62cfa2af'
  WHERE jid='feishu:oc_ba756e8614f1146b767a80f072604350' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:9934f320-ddc2-4c6b-a9f2-cc92478e1e78'
  WHERE jid='feishu:oc_bd5d9107d3ed796a192df441a0394500' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:ef82bdb2-d9ac-4616-b495-1901a02ee7a4'
  WHERE jid='feishu:oc_c0f1a4c84eb7cf08217230b8125f417b' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:68efae38-6f7b-470f-8d07-f01a9e6d7981'
  WHERE jid='feishu:oc_c1767da0ba8b035c48ff76a55f8b7fa6' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:9c48b10f-d8db-4f11-bdc5-02290db40bb1'
  WHERE jid='feishu:oc_c4d3eb35eaeeb2f641eb51398ac246c4' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:ad04ed41-a319-408b-acdc-d355ec611884'
  WHERE jid='feishu:oc_efa9f108cb44ec9c65814c9a44a9992d' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:a9d3c139-a83f-4a06-ade6-08128522f571'
  WHERE jid='feishu:oc_f2acf16601370ebd62add5f3bc2ffa15' AND (target_main_jid IS NULL OR target_main_jid='');
UPDATE registered_groups SET target_main_jid='web:49157f9d-fefe-422e-91aa-3657d3fc63a7'
  WHERE jid='feishu:oc_f6f58cd4542357bdc224264a2f336249' AND (target_main_jid IS NULL OR target_main_jid='');

COMMIT;
