# Git Forge

Forge git yang kompatibel dengan GitHub dalam satu proses Node.js, tanpa
dependensi dan tanpa antarmuka: git smart HTTP, REST API v3, GraphQL v4,
dan MCP (Model Context Protocol). Dibangun untuk kompetisi
`github-core-clone-01` di make.fun.

## Menjalankan

```sh
node main.ts
```

Persyaratan:

- Node.js 22.18 atau lebih baru (sintaks TypeScript yang dipakai adalah
  sintaks erasable, jadi tidak perlu langkah build).
- Variabel lingkungan `MAKEFUN_ENV_URL` harus diatur: forge mengikat port
  ephemeral, mendaftarkan port itu ke environment, melayani permintaan
  sampai environment menandai selesai, lalu keluar dengan kode 0.
- `MAKEFUN_SHOP_TOKEN` dipakai sebagai token bearer untuk permukaan API
  (`/api/*` dan `/mcp`). Bila tidak diatur, autentikasi dimatikan — hanya
  untuk pengembangan lokal.
- `MAKEFUN_TRIAL_NOW` dipakai sebagai dasar seluruh stempel waktu yang
  dikirim, agar balasan deterministik antar putaran ulang.

Tidak ada langkah instalasi: hanya pustaka standar Node (`node:http`,
`node:crypto`, `node:zlib`).

## Permukaan

| Permukaan | Rute | Keterangan |
| --- | --- | --- |
| Kesehatan | `GET /healthz` | `{"ok": true}`, tanpa token |
| Git smart HTTP | `/{owner}/{repo}.git/...` | `info/refs`, `git-upload-pack` (protokol v2 dan v0), `git-receive-pack` (v0, report-status) |
| REST v3 | `/api/v3/...` | root, meta, user, repo, cabang, commit, contents, ref git, label, issue, komentar, pull request, merge |
| GraphQL v4 | `/api/graphql` | parser dan eksekutor GraphQL sungguhan, termasuk introspeksi `__type`, mutasi, dan batching |
| MCP | `/mcp` | JSON-RPC 2.0: `server/discover`, `initialize`, `tools/list`, `tools/call` dengan 6 tool |

## Cara kerja

- **Store git sendiri** (`gitobj.ts`): objek SHA-1 (blob/tree/commit/tag),
  pkt-line, packfile v2 tanpa delta untuk pengiriman, pembaca packfile
  lengkap dengan delta (OFS/REF), traversal berbatas kedalaman untuk
  fetch dangkal, diff, dan merge tiga arah di tingkat path.
- **Status bersama** (`forge.ts`): repositori, ref, issue, pull request,
  label, dan komentar hidup di memori dalam satu `Forge`, sehingga git,
  REST, GraphQL, dan MCP selalu melihat status yang sama dan hash yang
  konsisten.
- **Owner dipelajari**: token bearer bersifat opaque dan tidak membawa
  nama login, jadi forge mempelajari login pemilik dari permintaan
  pertama yang menamai owner dari repositori yang ada. Permintaan dengan
  owner lain sesudahnya dijawab 404 (atau null di GraphQL), seperti
  GitHub.
- **Deterministik**: tidak ada jam dinding dan tidak ada keacakan tanpa
  benih di nilai apa pun yang dikirim. Stempel waktu berasal dari
  `MAKEFUN_TRIAL_NOW` ditambah penghitung monoton.
- **Satu proses**: tidak ada layanan luar, tidak ada proxy, tidak ada
  biner git, tidak ada UI.

## Struktur berkas

| Berkas | Isi |
| --- | --- |
| `main.ts` | Siklus hidup: listen ephemeral, register, polling done, keluar 0 |
| `app.ts` | Server HTTP, routing permukaan, autentikasi, request id |
| `forge.ts` | Status bersama: repo, objek, ref, issue, PR, merge |
| `gitobj.ts` | Objek git, pkt-line, packfile, traversal, diff, merge |
| `githttp.ts` | Git smart HTTP (iklan, fetch, push) |
| `rest.ts` | REST API v3 |
| `graphql.ts` | Parser dan eksekutor GraphQL |
| `mcp.ts` | MCP: discovery, tools/list, tools/call |
| `respond.ts` | Bantu baca badan dan kirim jawaban HTTP |

## Lisensi

MIT — lihat `LICENSE`.
