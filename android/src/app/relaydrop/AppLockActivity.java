package app.relaydrop;
import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.view.*;
import android.widget.*;

/** Only the system credential result unlocks the local interface. */
public final class AppLockActivity extends Activity {
  private boolean checking;
  @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);LinearLayout box=new LinearLayout(this);box.setOrientation(1);box.setGravity(Gravity.CENTER);box.setPadding(48,48,48,48);TextView title=new TextView(this);title.setText("星月夜界面已锁定\n\n共享和后台任务按原设置继续。\n暂停共享是独立操作。");title.setTextSize(20);box.addView(title);Button unlock=new Button(this);unlock.setText("验证系统锁屏密码并解锁");unlock.setOnClickListener(v->authenticate());box.addView(unlock);Button leave=new Button(this);leave.setText("留在后台");leave.setOnClickListener(v->moveTaskToBack(true));box.addView(leave);setContentView(box);if(!AppLock.isLocked(this))finish();}
  private void authenticate(){if(checking)return;KeyguardManager manager=(KeyguardManager)getSystemService(KEYGUARD_SERVICE);Intent intent=manager==null?null:manager.createConfirmDeviceCredentialIntent("解锁星月夜","使用设备锁屏密码或图案验证");if(intent==null){Toast.makeText(this,"系统锁屏验证不可用。请在系统安全设置中检查锁屏密码。",Toast.LENGTH_LONG).show();return;}try{checking=true;startActivityForResult(intent,907);}catch(Exception e){checking=false;Toast.makeText(this,"无法打开系统身份验证",Toast.LENGTH_LONG).show();}}
  @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==907){checking=false;if(result==RESULT_OK){AppLock.unlock(this);finish();}}}
  @Override public void onBackPressed(){moveTaskToBack(true);}
}
