package app.relaydrop;
import android.app.*;
import android.widget.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
/** Worker-thread prompt; an unauthenticated identity is never silently persisted. */
final class TrustPrompt {
  static boolean confirm(Activity activity,TlsIdentity.Peer peer)throws InterruptedException{CountDownLatch latch=new CountDownLatch(1);AtomicBoolean yes=new AtomicBoolean();activity.runOnUiThread(()->{if(activity.isFinishing()||activity.isDestroyed()){latch.countDown();return;}TextView text=new TextView(activity);text.setPadding(32,24,32,24);text.setTextIsSelectable(true);text.setText("请在接收设备的「设备」页面，对照下面完整的 SHA-256 证书指纹。只有全部一致才确认。\n\n"+peer.fingerprint.replaceAll("(.{8})(?!$)","$1 ")+"\n\n设备 ID："+peer.serverId+"\n地址："+peer.origin+"\n\n此时尚未发送配对码或连接凭据。");new AlertDialog.Builder(activity).setTitle("核对接收设备身份").setView(text).setNegativeButton("取消",(d,w)->latch.countDown()).setPositiveButton("指纹完全一致，继续",(d,w)->{yes.set(true);latch.countDown();}).setOnCancelListener(d->latch.countDown()).show();});for(int i=0;i<1200;i++){if(latch.await(250,TimeUnit.MILLISECONDS))return yes.get();if(activity.isFinishing()||activity.isDestroyed())return false;}return false;}
}
