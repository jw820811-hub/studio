# Cloud03 與 Woody’s Studio 串接

這個服務讓 ChatGPT／Cloud03 在授權後，讀寫 Woody’s Studio 現有的 Firebase 資料。網站本身透過 Firestore 即時監聽顯示結果，不需要另建一套待辦或投稿資料。

**目前狀態：程式與本機測試完成；尚未部署，也尚未完成真實帳號、Firestore 與 ChatGPT 端的連線驗證。**

## 可用操作

| 操作 | 權限 | 範圍 |
| --- | --- | --- |
| `studio_search` | 讀取 | 搜尋行程、待辦、投稿、研究計畫；須處理分頁 |
| `studio_get_record` | 讀取 | 取得單筆文字資料與版本時間 |
| `studio_create_event` | 寫入 | 建立單次行程或「重要事項」 |
| `studio_create_task` | 寫入 | 建立待辦與日期 |
| `studio_update_paper` | 寫入 | 更新投稿狀態、相關日期、備註 |
| `studio_complete_task` | 寫入 | 完成或重新開啟待辦 |

附件內容與下載連結、作者聯絡資料、計畫經費不提供給工具。既有資料中的這些欄位在更新時會保留。沒有刪除、寄信、Google 行事曆同步或通知功能；建立行程預設「不提醒」。只有資料連接完成後，才能進一步驗證 Cloud03 的實際使用體驗。

可在連線後試用：「查一下本週要完成的事」、「新增 11 月 20 日下午兩點的研究會議」、「把這篇投稿改成修改中，修回期限 12 月 1 日」。更新既有資料前需先找到正確紀錄，使用回傳的 `updatedAt`；不能自行猜測 ID 或投稿名稱。

## 現有網站與程式來源

本儲存庫原本的 `index.html` 是舊版單頁程式，與目前 Firebase 上線版不同。**不可把儲存庫根目錄部署覆蓋到 `woodys-studio` Hosting site。** 本次只新增獨立串接服務，沒有修改原本的首頁。

本次資料格式依據 2026-11-06 取得的公開上線資產：

- 網站：<https://woodys-studio.web.app/>
- `index.html` SHA-256：`abfe1b2eb43303a1731de91b5e435828f62a0c7b9bea5180f03c5dd84cd625b7`
- `/assets/index-C84Bq42e-type-v1.js` SHA-256：`fbdc166467a684c00d77efc727f91ee36f27e73d93a7863e2548cec5a59d64c2`
- `/assets/calendar-style-important-v2.css` SHA-256：`943dec322390830bfbd901b7963b0935eced8ae7f1cbd1a21bf0db80668efe00`
- `/assets/important-items-v2.js`：用來核對提醒選項。
- 既有登入：Firebase Authentication／Google。
- 既有資料：`users/{uid}/records/{kind}__{id}`，文件結構 `{kind, value}`。
- `updatedAt` 為 ISO 日期時間，`deletedAt` 非空代表回收桶紀錄。

這是依公開前端確認的格式，尚未讀取任何使用者的真實 Firestore 資料。正式部署前需確認實際規則與一筆本人授權的紀錄格式仍一致。

## 本機驗證

使用 Node.js 22：

```sh
cd cloud03
npm ci
npm run check
npm audit --omit=dev
```

測試涵蓋跨帳號隔離、日期與欄位驗證、版本衝突、並行重試不重複新增、保留既有附件欄位、分頁、私有資料加密，以及經由真實 HTTP／MCP transport 的 OAuth discovery、PKCE、授權碼一次性、來源與 Cookie 綁定、權限縮減、token 輪替與撤銷。Firebase 身分驗證與資料庫以測試替身處理，不能視為正式環境端對端通過。

`rimraf` 暫時固定為 6.1.4，避免 Firestore 間接依賴帶入已通報的 glob／minimatch 漏洞；此版本支援 Node.js 22。更新 Firebase 相依套件後應檢查能否移除 override。

## 部署設定與尚需取得的存取權

需要管理 `woodys-studio` Firebase 專案的已登入連線，確認現有計費方案、Functions、Hosting、Authentication、Firestore 規則與 Secret Manager。不得自動開通新的付費方案。

1. 讀取並保存既有 Firebase 設定與 Firestore rules。確認一般使用者只能讀寫自己的 `users/{uid}`，且不能讀寫 `_cloud03_private/{document}`。若已有廣泛的 `allow`，只新增 `allow false` 無法覆蓋它，必須先修正並驗證實際規則；本變更不附帶或覆蓋未知的現有規則。
2. 在同一 Firebase 專案新增一個**獨立** Hosting site，將 Hosting target `cloud03` 對應至這個新 site。名稱要以 Firebase 實際核准的 site ID 為準，不可對應到現有 `woodys-studio` site。
3. 設定 `CLOUD03_ORIGIN` 為新 site 的 HTTPS 根網址，不能有路徑或結尾 `/`。將它的 hostname 加入 Firebase Authentication authorized domains。
4. 以密碼學安全亂數產生 32-byte 金鑰，base64 編碼後直接寫入 Secret Manager 的 `CLOUD03_ENCRYPTION_KEY`。不要貼進對話、前端、Git 或日誌；不要在已儲存授權資料後直接換新金鑰，否則舊資料將無法解密。環境變數檔已加入 gitignore。
5. 從儲存庫根目錄，明確指定本次設定與部署範圍：

```sh
firebase deploy --project woodys-studio --config firebase.cloud03.json --only functions:cloud03,hosting:cloud03
```

這裡的 `functions:cloud03` 指獨立的 functions codebase；不要用未限定範圍的 `firebase deploy`。Hosting target 對應應先經人工／工具檢查，防止覆蓋既有網站。程式的 Functions region 為 `asia-east1`，最小執行個體 0、最大 2。

6. 檢查新站 `/health`、`/.well-known/oauth-authorization-server` 及受保護的 `/mcp`；無憑證呼叫 `/mcp` 必須回傳 401。確認網站原網址與資料仍正常。
7. 在 ChatGPT 支援的自訂外掛／MCP 設定加入新站的 `/mcp`，選 OAuth。連線以 Google 登入既有工作台帳號，可勾選讀寫或只讀。此步驟還需實際確認使用者帳號的介面支援及 Cloud03 可呼叫工具。
8. 先用只讀權限核對本人紀錄，再在獲准的測試資料上驗證「新增 → 網站出現 → 重試不重複 → 修改 → 網站同步」。測試時不得改動既有投稿作為示範。最後驗證撤銷授權後無法繼續存取。

## 授權與資料處理

- UID 只從已驗證的 Firebase 身分取得，工具參數不能指定別人的 UID。
- OAuth 採 S256 PKCE，callback 限定 HTTPS 的 `chatgpt.com`／`chat.openai.com`；註冊的 callback 必須精確匹配。
- 瀏覽器授權頁只暫存 Firebase ID token，授權請求須符合 Origin 與隨機 HttpOnly Cookie。
- Access token 有效 1 小時，refresh token 輪替，授權最長 30 天；撤銷會使該次授權的所有 token 失效。
- 私有授權與操作紀錄存於 `_cloud03_private`，內容使用 AES-256-GCM 加密，金鑰由 Secret Manager 提供。令牌索引使用雜湊；Firestore 一般用戶規則仍須禁止存取此集合。
- 每次寫入有 UUID `requestId`、交易與內容指紋；同一指令重試只套用一次。更新需帶上原紀錄版本，避免覆蓋網站上的新編輯。
- 操作紀錄保留變動欄位的前值及回傳結果。目前沒有自動回復介面與資料清理排程；過期 token 會失效，但文件仍留存。正式長期使用前需訂定保留與清理政策。

本服務只建立網站資料與 Cloud03 間的連接，不會把 ChatGPT 的全部記憶搬進網站，也不會在網站內自動產生聊天視窗。首頁重整、Gmail 自動擷取與手機提醒應在這條連線驗證後分階段處理。
