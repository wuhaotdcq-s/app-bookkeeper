import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

// ============================================================
// TODO 改成你自己的 GitHub Pages 地址（先在手机浏览器里确认能打开）
// 例如：https://你的用户名.github.io/app-bookkeeper/
// ============================================================
const APP_URL: string = 'https://wuhaotdcq-s.github.io/app-bookkeeper/';

const DOMAIN: number = 0x0000;
const TAG: string = 'BookKeeper';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State loading: boolean = true;
  @State loadError: boolean = false;

  build() {
    Stack() {
      // 记账网页（WebView 全屏承载）
      Web({ src: APP_URL, controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true) // 网页 localStorage（同步配置/缓存）依赖此开关
        .fileAccess(true)
        .onlineImageAccess(true)
        .onPageBegin(() => {
          this.loading = true;
          this.loadError = false;
        })
        .onPageEnd(() => {
          this.loading = false;
        })
        .onErrorReceive((event) => {
          hilog.error(DOMAIN, TAG, '页面加载失败: %{public}s', JSON.stringify(event));
          this.loading = false;
          this.loadError = true;
        })
        // 允许网页弹窗（记账页面的“确定删除”确认框、账本重命名输入框）
        .onAlert(() => {
          return true;
        })
        .onConfirm(() => {
          return true;
        })
        .onPrompt(() => {
          return true;
        })

      // 加载中提示
      if (this.loading) {
        Column() {
          LoadingProgress()
            .width(48)
            .height(48)
            .color(Color.Blue)
          Text('正在打开记账本…')
            .fontSize(13)
            .fontColor('#8a94a6')
            .margin({ top: 12 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor(Color.White)
      }

      // 加载失败提示 + 重试
      if (this.loadError) {
        Column({ space: 16 }) {
          Text('无法连接到记账网页')
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
          Text('请检查网络，或确认 GitHub Pages 地址能正常打开\n（首次使用请先在手机浏览器访问该地址）')
            .fontSize(13)
            .fontColor('#8a94a6')
            .textAlign(TextAlign.Center)
          Button('重新加载')
            .backgroundColor('#3b82f6')
            .onClick(() => {
              this.loadError = false;
              this.loading = true;
              this.controller.reload();
            })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor(Color.White)
        .padding(24)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.White)
  }
}
