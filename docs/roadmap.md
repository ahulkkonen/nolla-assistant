# Roadmap

Work that is planned but not built. Each item says what it closes and what it costs. Items are not
in order; the first one that gets a user is next. The residual risks that these items close are in
`docs/threat-model.md` section 5.

| Item | Closes | Cost |
|---|---|---|
| English UI | The interface is Finnish only. First the server sends codes with parameters instead of prose, then the client renders them from two string tables with a `t(key, params)` helper, and the language is a setting that switches without a reload. The e2e locators keep `fi`. | 2 to 3 days. About 1 000 strings in `apps/web`, `apps/server` and `packages`. |
| Masking for English text | The corpus is Finnish only. Finnish names and codes are caught in English text; names outside the DVV list are not, because the NER model is Finnish. Needs an English corpus slice, language detection per message and an English NER model or a rule for foreign names. | 1 to 2 days. |
| Image and audio redaction | Images and voice audio reach the model unmasked. Local image redaction and a local Whisper. | Days. Deferred in the plan, section 15. |
| Direct search backend | A web search query reaches Exa unmasked when it names no vault entity. A search provider with ZDR terms. | 1 day. |
| Masked artifacts in every chat | An HTML artifact in an untainted chat runs on restored text. Mask in every chat, reveal on request, as tainted chats do. | Half a day. |
| Links from masked text | A Markdown link in a reply is restored before it renders, so a click sends the restored URL. Render links from the masked text, or show the full URL before navigation. | Half a day. |
| `pseudo-svc` request token | The sidecar has no authentication; the `pseudo` network is the fence. A per-request token and a narrower API. | Half a day. |
| Vault copy without the key in the backup container | The backup container holds the vault key. A copy that `pseudo-svc` writes itself. | Half a day. |
| Work-dir quota | The agent can fill the disk through `bash`; the Files screen has a quota, the work dir has none. | Hours. |
| Text-to-speech, multi-user | Deferred in the plan. | Open. |
