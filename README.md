# PLY自己位置推定（iPhone / GitHub Pages）

PLY点群＋iPhoneカメラで、自分がどの位置にいるか・YZ平面（地面と平行な平面）上でどっちを向いているかを推定する静的サイトです。

## 仕組み
- PLYをブラウザで直接パース（Three.js PLYLoader）
- PLYから「上から見た図（上面投影・高さ色分け・1mグリッド）」を自動生成
- ライブ画面＝実カメラ映像＋点群3Dオーバーレイ。重なるように移動・旋回させると、そのときのカメラ pose が自己位置・向きになる
- 向きは iPhone コンパス（`webkitCompassHeading`）連動可、傾きはジャイロ連動可、歩行で前進（加速度ステップ検出）可
- 上面図タップで位置指定、位置と向き（赤矢印＋視野コーン）が表示される

## 使い方（iPhone）
1. `https://` で開く（httpではカメラ不可）
2. 「PLYを選択」→「センサー許可」→「カメラ開始」
3. ライブで点群と現実を重ねる（十字キー／旋回）
4. 上面図に位置●と向き▲が表示される

地面の定義：
- `YZ平面（Xが上）` … 既定値
- 一般的なPLY（Yが上）なら `XZ平面` に切替

URL直読み： `?ply=https://example.com/map.ply`

## GitHub Pages 公開
### 方法A: ブランチ公開（最速）
1. このフォルダをGitHubリポジトリにする
2. Settings → Pages → Deploy from a branch → `main` / root
3. `https://<user>.github.io/<repo>/` で開く

### 方法B: Actions公開
`.github/workflows/pages.yml` 同梱済み。mainにpushで自動公開。

## ローカル確認
```powershell
python -m http.server 8000
# http://localhost:8000 をPCで（上面図・デモ点群まで確認可）
# カメラ・コンパスは https の実機でのみ確認
```
