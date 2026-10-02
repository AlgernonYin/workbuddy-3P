# Official catalog compatibility / 官方目录兼容（2.5.1）

## 中文

- 插件路由提交和宿主实际模型绑定是两件事。`runtimeVerified:false` 保持不变；必须实际发请求验证。
- 在云端 Native 2.155.0 的同一测试沙箱中，官方切换撤销模型并使旧 opaque 请求返回410，但删除 `availableModels` 后仍报 `custom-local:glm-5.1` 无 endpoint；刷新网页重选也失败。仅显式写入随包41项官方清单后，重选的官方 GLM-5.1 请求成功。这不证明所有宿主版本或手机真机均已通过。
- 仅在撤销原有托管路由且用户原本没有 allowlist 时生成兼容目录。随包目录与已记录的官方路由 ID 不等于宿主实时完整清单：新增、删除模型可能存在版本差异。保留恢复的用户自定义槽位；同 ID 遮蔽会返回 `officialCatalogConflicts`，不删除用户模型。
- `officialCatalogFallback:true` 的 state 使用 `allow` 保存当时完整 projection，不含 provider key。空托管集合的归属 marker 用于防止丢失 state 后误删目录。
- projection 完全未变时，切第三方或卸载清理根据旧 state 恢复原始字段缺失，不根据新版 preset 猜历史所有权。外部改变字段（包括顺序、删减）后，卸载原样保留当前字段并告警；直接切第三方拒绝。先恢复记录的 projection，或在保留配置的情况下运行 `--uninstall` 清理旧路由归属，再按用户的新配置启用第三方。
- 无法识别“用户认可了某个已存在 ID、但数组完全未变”的新意图；不宣称能完美识别外部意图。所有写者应使用同一锁；最终比较到写入仍有非协作写者竞争窗口，不是 OS 级 CAS 或跨文件 crash-atomic。
- 目录缺失、无效或为空时仅安全撤销第三方路由，返回 `fallbackUnavailable` 与宿主刷新提示；绝不写空兼容 allowlist。
- 回环仍只在目标宿主内运行，官方模式拒绝旧第三方缓存，不用自定义 endpoint 回指官方服务来伪装 official。随机端口避开 WHATWG Fetch 禁用端口，不禁用 Fetch 安全检查。

## English

- A committed routing transaction is not a verified native model binding. `runtimeVerified:false` remains; verify real requests.
- On one cloud Native 2.155.0 sandbox, official mode removed managed models and rejected old opaque requests with410, yet removing `availableModels` left a stale custom-local GLM-5.1 binding even after page reload/reselection. An explicit41-entry bundled official list restored a real official GLM-5.1 response. This does not certify every host version or a physical phone.
- Generate a compatibility catalog only when withdrawing existing managed routes from a configuration that originally had no allowlist. Bundled/recorded official IDs are not a live authoritative host catalog; host/preset versions can differ. Preserve restored user custom slots and warn about same-ID shadowing through `officialCatalogConflicts`.
- Catalog-only state records `officialCatalogFallback:true` and the exact historical projection in `allow`, without provider credentials. An empty managed-set marker prevents destructive cleanup if ownership state disappears.
- If unchanged, cleanup restores the original field absence from stored ownership, not a newer preset. If externally added, deleted or reordered, uninstall preserves the entire current field verbatim with a warning; direct third-party activation refuses. Restore the projection, or use routing `--uninstall` without deleting user configuration, then enable routing under the user's new configuration.
- An invisible change of intent that leaves an array identical cannot be detected. Cooperating writers share the lock; the final comparison/write window remains a limitation, not OS-level CAS or cross-file crash atomicity.
- Missing, invalid or empty fallback catalogs disable managed routing but report `fallbackUnavailable`/host refresh requirements. Never create an empty compatibility deny-all.
- No webpage modifications, maintainer-PC dependency, invented private RPC or custom endpoint pretending to be native official routing. The target-host loopback rejects stale third-party bindings in official mode and skips WHATWG Fetch-blocked random ports without disabling safety checks.
