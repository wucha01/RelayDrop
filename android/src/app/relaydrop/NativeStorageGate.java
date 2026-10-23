package app.relaydrop;

import java.io.IOException;

/** Serializes native exports/restores with background save attempts. */
final class NativeStorageGate {
  private static boolean maintenance;
  private static int saves;
  static synchronized void beginSave() throws IOException { if(maintenance)throw new IOException("文件池正在备份或恢复，后台保存稍后自动重试。"); saves++; }
  static synchronized void endSave(){if(saves>0)saves--;}
  static synchronized void beginMaintenance() throws IOException {if(maintenance||saves>0)throw new IOException("后台保存或存储任务正在进行，请暂停任务后再备份或恢复。");maintenance=true;}
  static synchronized void endMaintenance(){maintenance=false;}
}
