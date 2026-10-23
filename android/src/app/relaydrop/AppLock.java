package app.relaydrop;
import android.app.*;
import android.content.*;

final class AppLock {
  static boolean isLocked(Context c){return c.getSharedPreferences("interface-lock",Context.MODE_PRIVATE).getBoolean("locked",false);}
  static void lock(Activity a){KeyguardManager keyguard=(KeyguardManager)a.getSystemService(Context.KEYGUARD_SERVICE);if(keyguard==null||!keyguard.isDeviceSecure()){new AlertDialog.Builder(a).setTitle("请先设置系统锁屏密码").setMessage("应用锁使用此设备的锁屏密码或图案。当前未设置，因此不能提供安全的界面锁。共享和后台任务不会受影响。").setNegativeButton("返回",null).setPositiveButton("系统安全设置",(d,w)->{try{a.startActivity(new Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS));}catch(Exception ignored){}}).show();return;}if(!a.getSharedPreferences("interface-lock",Context.MODE_PRIVATE).edit().putBoolean("locked",true).commit()){android.widget.Toast.makeText(a,"无法保存锁定状态，请重试。",android.widget.Toast.LENGTH_LONG).show();return;}a.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);a.getWindow().getDecorView().setAlpha(0f);a.startActivity(new Intent(a,AppLockActivity.class));}
  static void unlock(Context c){c.getSharedPreferences("interface-lock",Context.MODE_PRIVATE).edit().putBoolean("locked",false).commit();}
}
