package app.relaydrop;

/** Local UI protection is independent of sharing and background queue lifetime. */
public class SecureActivity extends android.app.Activity {
  @Override protected void onPause(){if(AppLock.isLocked(this)){getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);getWindow().getDecorView().setAlpha(0f);}super.onPause();}
  @Override protected void onResume(){super.onResume();boolean locked=AppLock.isLocked(this);if(locked)getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);getWindow().getDecorView().setAlpha(locked?0f:1f);if(locked)startActivity(new android.content.Intent(this,AppLockActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP));}
}
