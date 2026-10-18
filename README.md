# cai v1.2

## v1.1からの更新：オンラインでも返事がないときの診断

v1.2は、メッセージを受け取ってから返事を送るまで、どの処理が待機しているか分かるようにする更新や。Discordの429制限そのものを解除する更新ではない。追加の環境変数やAPIキーは不要。

更新用ZIPを展開し、中の **`src`・`test`・`package.json`・`package-lock.json`・`README.md`の5個** を、GitHubのCAI-project → Add file → Upload filesへまとめてドラッグする。フォルダーの形を保ったままCommit changesし、Renderでこの更新のデプロイが終わるのを待つ。更新用のsrcフォルダーに入っていない既存ファイルは、そのままGitHubに残る。

ログに`cai v1.2 health endpoint listening`が出れば更新が反映されてる。Discordに接続したら、候補から選んだ本物のcaiメンションを1回だけ送って確認する。本文なしならGeminiを使わない相槌、本文ありなら通常の質問処理になる。Renderログの **`[cai Message]`** と **`[cai Discord]`** を確認してな。429の待機時間が出ている間は連投や再デプロイを繰り返さない。

### メッセージ処理の段階

`[cai Message]`は、cai宛てと判定したメッセージだけを対象に、受信、各段階の開始・完了・失敗、処理の終了を記録する。15秒以上同じ処理が終わらなければ、その段階で待機中という警告を1回出す。この警告で処理を中止したり、再送したりはしない。

例えば、次の最後の行なら「入力中」の表示を送る通信で待機している。

```text
[cai Message] m1 received
[cai Message] m1 stage=settings started
[cai Message] m1 stage=settings completed
[cai Message] m1 stage=typing started
[cai Message] m1 stage=typing waiting elapsedSeconds=15
```

`stage=reply completed`はその返信の送信完了、`handler_finished`は処理の終了を示す。途中で失敗して終了した場合もあるので、`handler_finished`だけで回答が届いたとは判断しない。

| 段階 | 待っている処理 |
| --- | --- |
| `reference` | メンションに付いた返信先の取得 |
| `settings` / `quota` | Neonの設定・質問回数の確認 |
| `typing` | Discordへ「入力中」を表示する通信 |
| `history` / `memory_search` | 必要な会話文脈・過去ログの取得 |
| `budget` | 無料枠の確認と、枠を確保した生成処理全体 |
| `web` / `gemini` | 必要時のWeb取得・Gemini生成 |
| `reply` / `followup` | 最初の返信・長い回答の続きの送信 |
| `save` / `accounting` / `refund` | 保存・トークン集計・失敗時の質問回数返却 |

通常の雑談・DM・許可していないサーバーなどにはメッセージ診断を出さない。メンションなしの返信は、返信先がcaiと確認できた時点で記録を始める。診断用の番号はプロセス内だけの連番で、Discordのユーザー・メッセージ・チャンネル・サーバーIDではない。本文・引用・添付名やURL・Token・APIキー・接続文字列・生のエラーやデバッグ本文は、新しい診断に渡さない。

### 接続成功とAPI待機を別々に確認

`/health`の`version`は`cai v1.2`になる。`discord:"ready"`はDiscord Gatewayへの接続状態で、返信を送れることやGeminiの応答成功までは保証しない。**`connection.rest.limited:true`なら、DiscordのHTTP APIでSDKが待機中**や。

`connection.rest.retryAfterSeconds`は残り待機秒数。取得できた場合だけ、固定した操作名`operation`、許可した`scope`と`global`、`lastCode`を付ける。操作名は`gateway_info`・`typing`・`message_send`・`message_read`・`admin_commands`などで、DiscordのIDやURLは公開しない。`unknown`や`other`の場合は、その情報だけで返信送信の制限と断定しない。

`lastCode:429`は実際のHTTP 429応答を確認した場合、`RATE_LIMITED`はSDKの通常の予告待機の場合。待機が終わると`limited:false`になるが、最後に観測した情報は履歴として残るので、`lastCode`だけで現在も制限中とは判断しない。`scope:shared`はDiscordのリソース単位の制限を示し、Renderの共有IPが原因という意味ではない。[DiscordのRate Limits](https://docs.discord.com/developers/topics/rate-limits)

`scope`はSDKが提供した値で、HTTPヘッダーをそのまま記録したものではない。特に`user`はSDKの既定値の場合もあるため、そのヘッダーが実際に返った証拠とは扱わない。

`ok:true`の基準はHTTPと初期DB準備の状態のまま。待機中にRenderが再起動を繰り返さないよう、Discordの接続・送信待機をHTTPの異常にはしない。SDKの待機や再試行、Botの返答や質問制限は従来どおりで、診断用のAPI問い合わせ・ログイン・メッセージ送信は追加しない。

エラーの見方：`4004`や`INVALID_TOKEN`ならBot Token、`4014`や`DISALLOWED_INTENTS`ならMessage Content Intent、`429`や`rate_limited`ならDiscordの待機指示、`ENOTFOUND`や`ETIMEDOUT`などはネットワークの確認が必要になる。診断表示だけでRender全体の障害や制限の原因を断定しないでな。

v1.2の検証（2026年10月18日）：自動テスト104件中103件成功、実PostgreSQL接続テスト1件は専用テストDBがないためスキップ。実際に使うDiscord REST SDKの通信を模擬し、typingと返信送信の429、GatewayがreadyのままRESTが待機する状態、ログと公開状態への秘密情報の混入防止、処理待機中の段階表示を確認した。この更新の検証では本番のDiscord・Neon・Geminiへ接続していない。

関西弁で話す非公開Discord Bot。Node.js + discord.js、Gemini API、Neon PostgreSQLで動くで。返答は内容に合わせた長さで、ジョジョネタはたまに。

## 使い方

| 送るもの | 動作 |
| --- | --- |
| `@cai 質問の本文` | Geminiで回答 |
| caiの発言への返信 | メンションなしで会話を継続 |
| 他の人の発言への返信 + `@cai 質問` | その返信先の文章・画像・動画も今回の文脈に含める |
| `@cai` だけ | APIを使わずランダムに相槌。質問回数も減らさない |
| `@cai 過去ログ: 京都旅行` | 自分とcaiの保存会話をキーワード検索 |
| `@cai 最新のニュースを調べて` | 必要時にWeb検索を試す |
| `@cai https://example.com/ を説明して` | 公開HTTPSページの本文取得を試す |

DMには反応しない。Bot・Webhookの投稿にも反応しない。1人につき全サーバー共通で1日30質問、日本時間の午前0時にリセット。失敗した質問は回数の返却を試みる。

## 1. Discordの設定

[Discord Developer Portal](https://discord.com/developers/applications)でcaiのアプリを開く。

1. **Bot → Public BotをOFF**。アプリ所有者が選んだサーバーに招待する。
2. **Bot → Privileged Gateway Intents → Message Content IntentをON**。caiへのメンションなしの返信や、返信先の本文を読むために必要。
3. Installationのインストール先は**Guild Install**を使う。User Installは使わない。
4. OAuth2の招待リンクに **`bot` と `applications.commands`** を含める。
5. Botの権限は **View Channels / Send Messages / Read Message History**。Discordのスレッドでも使うならSend Messages in Threadsも付ける。BotへAdministratorを与える必要はない。
6. アプリ所有者のアカウントで招待リンクを開き、利用サーバーと管理サーバーにcaiを入れる。同じサーバーでもOK。

非公開アプリの既定インストールリンクで設定エラーが出る場合は、InstallationのInstall LinkをNoneにし、OAuth2 URL Generatorから所有者用の招待リンクを作る。チャンネル単位の権限も確認してな。

管理コマンドは管理サーバーでのみ登録し、コード内でも**管理サーバーIDと所有者ユーザーIDの両方**を確認する。Discord上の既定表示権限はAdministratorなので、所有者に管理者権限がない場合は「サーバー設定 → 連携サービス → cai」でコマンド権限を調整する。

参考：[Discordの非公開Bot設定](https://docs.discord.com/developers/resources/application)、[Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent)、[インストール設定](https://docs.discord.com/developers/quick-start/getting-started)、[コマンド権限](https://docs.discord.com/developers/interactions/application-commands#permissions)。

## 2. 必須の環境変数

RenderのEnvironmentに、準備した次の5つを直接入れる。実際の値をGitHub、README、チャットには貼らないでな。

| 名前 | 入れるもの |
| --- | --- |
| `DISCORD_TOKEN` | Developer PortalのBot Token |
| `GEMINI_API_KEY` | Gemini APIキー |
| `DATABASE_URL` | NeonのPostgreSQL接続文字列。Neonの接続画面からSSL付きのものを使う |
| `OWNER_USER_ID` | 所有者本人のDiscordユーザーID |
| `ADMIN_GUILD_ID` | 管理用DiscordサーバーID |

この5つで起動できる。テーブルは初回起動時に`sql/schema.sql`から自動作成する。SQLを手動実行する必要はない。

任意の設定は`.env.example`を参照。主な初期値は次のとおり。

| 名前 | 初期値 | 用途 |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | 利用モデル |
| `GEMINI_DAILY_REQUEST_LIMIT` | `20` | cai全体の1日生成試行数の基準 |
| `GEMINI_RPM_LIMIT` | `5` | cai全体の1分あたり試行数 |
| `GUARD_WARN_PERCENT` | `80` | 警告割合 |
| `GUARD_STOP_PERCENT` | `90` | 停止割合 |
| `ALLOWED_GUILD_IDS` | 空欄 | 利用を許可するサーバーID。複数ならカンマ区切り |
| `MAX_OUTPUT_TOKENS` | `4096` | 回答の最大出力トークン数 |

`ALLOWED_GUILD_IDS`が空欄ならDiscordへの招待で利用範囲を管理する。設定する場合は利用サーバーIDをすべて含める。

## 3. GitHubのCAI-projectへ入れる

1. GitHubで**CAI-project**を開く。秘密のコードとして扱いたいならPrivateリポジトリにする。
2. **Add file → Upload files**から、この配布フォルダーの**中身**をアップロードする。
3. リポジトリ直下に`package.json`が見え、`src/`、`sql/`、`test/`がそれぞれフォルダーのまま残ることを確認してCommitする。

目安の配置：

```text
CAI-project/
  .env.example
  .gitignore
  .node-version
  package.json
  package-lock.json
  README.md
  src/
  sql/
  test/
```

`CAI-project-v1.2`フォルダーをもう1階層挟まない。`.env`、`node_modules/`、実際のAPIキーや接続文字列はアップロードしない。`.gitignore`はGitからの誤追加を防ぐが、ブラウザーからの手動アップロードは自分でも確認してな。

## 4. Renderで起動

Web ServiceでGitHubのCAI-projectを接続する。

| Render設定 | 値 |
| --- | --- |
| Language / Runtime | Node |
| Root Directory | 空欄（上の配置の場合） |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |
| Health Check Path | `/health` |
| Pre-Deploy Command | 空欄 |
| Auto-Deploy | On Commit |

`.node-version`でNode.js **24.18.0**を指定している。PORTはRenderが渡す値を利用する。Secret Filesは不要。

5つの環境変数を確認してDeployする。起動ログに`cai v1.2 connected`が出たらDiscordで`@cai こんにちは`を送る。管理サーバーで`/cai status`も確認する。`https://サービス名.onrender.com/health`は稼働状態を返すが、Geminiへの試し問い合わせは行わない。

**Render Freeでは常時オンラインを保証できへん。** 15分間受信トラフィックがないWeb Serviceは休止する。caiからDiscordへの接続は、休止後にDiscordで呼ぶだけで復帰できる仕組みにはなっていない。休止した場合はRenderのサービスURLを開いて復帰を待つ。休止回避用の自動アクセスは同梱していない。[Render公式のFree制限](https://render.com/docs/free)

## 無料枠ガードと管理コマンド

**ユーザーの30回制限と、cai全体のGemini上限は別。** 初期設定はcai全体で1日20回を基準に、16回で警告、18回まで受け付けて、その次の試行から停止する。複数ユーザー・複数サーバーで共有する。失敗した生成試行も安全側にカウントする。

| 管理サーバーで使うコマンド | 動作 |
| --- | --- |
| `/cai status` | 稼働状態、モデル、試行数、トークン集計、ガード設定など |
| `/cai maintenance enabled:true` | メンテナンス開始 |
| `/cai maintenance enabled:true message:いま調整中やで` | 案内文も指定 |
| `/cai maintenance enabled:false` | メンテナンス終了 |
| `/cai guard` | 現在の設定を見る |
| `/cai guard daily:20 warn:80 stop:90` | 上限・警告・停止割合を変更 |

メンテナンス中も所有者の管理コマンドは使える。設定はNeonへ保存し、再起動しても残る。`/cai guard`を変更しても当日のカウンターはリセットしない。警告割合は停止割合より小さくする。

日次上限と割合の環境変数は**初回登録用**で、保存済みの設定がある場合はNeon側が優先される。後からは`/cai guard`で変更する。モデルとRPMなどの設定はRenderの環境変数で変更する。

上限20回は安全寄りの仮設定や。**利用開始前に[AI Studioの実際の上限](https://aistudio.google.com/usage?timeRange=last-28-days&tab=rate-limit)を確認して設定する。** モデルの提供状況や無料枠は変わり得るため、必要なら`GEMINI_MODEL`も変更する。[Gemini料金表](https://ai.google.dev/gemini-api/docs/pricing)

このガードはcai自身の記録に基づく。Google側の残量照会、他アプリの使用量合算、トークン毎分上限、金額上限、NeonやRenderの無料枠監視までは行わない。課金が有効なプロジェクトで料金ゼロを保証する機能ではない。

ユーザー制限は**日本時間0時**、Geminiの日次集計は**米国太平洋時間0時（夏時間を含む）**に日付を切り替える。Gemini側の制限はプロジェクト単位なので、同じプロジェクトの別アプリも枠を使う。[Geminiの上限とリセット時刻](https://ai.google.dev/gemini-api/docs/rate-limits)

## 保存・過去ログ・添付

- Neonにはcaiに話しかけた本文とcaiの回答、会話継続に必要なIDなどを保存する。通常のサーバー雑談を一括保存しない。
- 保存期限は設けない。データベースの容量には上限があるため、必要に応じてNeonの容量を確認する。
- 通常の回答で全過去ログは読み込まない。caiへの返信では同じサーバー・同じチャンネルの該当会話の直近分だけを文脈に使う。他の人もそのcaiの発言へ返信した場合は、その会話の文脈を共有する。
- 過去ログ検索は`過去ログ: 京都旅行`、`ログ検索: おすすめの店`、`思い出して: パソコン`など明示的な言葉があるときだけ。検索対象は**同じサーバー・同じチャンネルの、自分とcaiの会話**。キーワードの文字列一致なので、短い語を指定すると探しやすい。
- 他の人の返信先本文は今回の引用文脈として扱い、独立した会話ログとして追加しない。caiの回答に引用や要約が含まれた場合、その回答文は保存される。
- 画像・動画は**1回4つまで、1ファイル最大200MB、合計も200MBまで**。200MBは200,000,000バイト。返信先から使う添付も合計に含む。Discord自身のアップロード制限と、Geminiの形式・長さ・解像度・トークン制限も適用されるため、200MB以下でも処理できない場合がある。
- 添付は一時フォルダーとGemini Filesへ一時アップロードして処理し、終了時に削除する。プロバイダー側の削除失敗はNeonの削除待ち一覧に残し、起動時・定期処理で再試行する。添付のバイナリはNeonへ保存しないが、caiが作った説明文・回答は保存する。異常終了時まで即時削除を保証するものではない。

無料のGemini APIへ送った文章・画像・動画・生成結果は、Googleのサービス改善に利用される場合がある。機密情報を送る前に利用条件を確認してな。[Geminiのデータ利用条件](https://ai.google.dev/gemini-api/terms)

## URLとWeb検索

最新情報を聞いたとき、検索を頼んだとき、URLを送ったときなど必要な場面だけ取得を試す。BingのRSS検索と公開HTTPSページのテキスト取得を使い、追加の検索APIキーは不要。caiからGeminiの有料Google Search groundingは有効にしない。

検索時は**今回の質問から作った最大300文字の検索語がBingへ送られる**。保存済み会話や返信先本文を検索語へ自動追加しない。ページ取得は公開HTTPSのみで、ログインが必要なページ、ローカルアドレス、巨大ファイルなどには対応しない。ページは最大2件、検索結果は最大5件を参考にする。

検索サービスやサイト側の制限で失敗することがある。取得できなかったときは未確認として扱い、最新情報を確認済みと断言しないよう指示している。Webの参考文は今回の処理だけに使うが、それを基にしたcaiの回答や出典リンクは会話ログに残る。

## ローカル起動とテスト

プロジェクトのフォルダーで実行する。

```sh
npm install
npm test
```

ローカルで本体を動かす場合は`.env.example`を`.env`へコピーし、自分のPC上で5つの値を記入して`npm start`。実際のDiscordとGeminiに接続し、利用枠を消費する。

通常のテストは外部APIを呼ばず、権限判定、クォータ、保存範囲、添付、URL取得制限などを確認する。PostgreSQLの実接続テストは`TEST_DATABASE_URL`がある場合だけ実行する。**専用テストDB**を指定すること。ランダムなテスト用スキーマを作成・削除する。

この配布物の自動テストで、本番のDiscord・Gemini・Neonへの接続を保証しているわけではない。初回デプロイ後に本人の設定で動作確認してな。

v1配布時（2026年10月17日）の検証：自動テスト69件成功、実PostgreSQL接続テスト1件は接続情報がないためスキップ。依存パッケージを実際に読み込み、Gemini SDKの模擬HTTPでアップロードと再試行抑止も確認した。公開RSSの取得では無関係な検索結果が返る場合もあったため、話題との関連性を確認し、使える結果がないときは未確認として扱う。

## 困ったとき

- **起動しない**：Renderログで不足している環境変数名を確認。Bot Token、Neonの接続文字列、Message Content Intentも確認。
- **`/cai`が出ない**：管理サーバーにcaiを招待済みか、`applications.commands`が付いているか、Discord側のコマンド権限を確認。
- **呼んでも反応しない**：Renderが休止していないか、チャンネル権限と`ALLOWED_GUILD_IDS`を確認。
- **無料枠ガードで休憩中**：`/cai status`とAI Studioを確認。ユーザーの30回に達していなくてもcai全体のガードで停止する。
- **キーを公開してしまった**：公開先から消すだけでなく、そのサービスで該当キー・トークンを再発行する。
