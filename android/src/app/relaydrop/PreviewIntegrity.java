package app.relaydrop;

import android.os.Build;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;

/** Decoding and original verification are separate; cached proofs bind to inode and nanosecond change time. */
final class PreviewIntegrity {
  private final LinkedHashMap<String,Long> verified=new LinkedHashMap<>(16,.75f,true);
  static String stamp(File source)throws IOException {
    try {StructStat s=Os.lstat(source.getAbsolutePath());if(!OsConstants.S_ISREG(s.st_mode))throw new IOException("预览原件不是普通文件。");
      if(Build.VERSION.SDK_INT>=27)return s.st_dev+":"+s.st_ino+":"+s.st_size+":"+s.st_mtim.tv_sec+":"+s.st_mtim.tv_nsec+":"+s.st_ctim.tv_sec+":"+s.st_ctim.tv_nsec;
      return s.st_dev+":"+s.st_ino+":"+s.st_size+":"+s.st_mtime+":"+s.st_ctime;
    }catch(android.system.ErrnoException error){throw new IOException("无法读取原件状态。",error);}
  }
  void invalidate(String id){synchronized(verified){verified.keySet().removeIf(key->key.startsWith(id+":"));}}
  String verify(File source,String id,String sha,long expectedSize,long maximum)throws IOException {
    if(expectedSize<0||expectedSize>maximum||!sha.matches("[a-f0-9]{64}")||source.length()!=expectedSize)throw new IOException("原件大小或校验记录无效。");
    String before=stamp(source),key=id+":"+sha+":"+before;long now=android.os.SystemClock.elapsedRealtime();
    synchronized(verified){Long proof=verified.get(key);if(Build.VERSION.SDK_INT>=27&&proof!=null&&now-proof<300000)return before;}
    try {MessageDigest digest=MessageDigest.getInstance("SHA-256");long count=0;try(InputStream in=new FileInputStream(source)){byte[] buffer=new byte[65536];for(int n;(n=in.read(buffer))!=-1;){if(Thread.currentThread().isInterrupted())throw new IOException("预览已取消。");count+=n;if(count>maximum||count>expectedSize)throw new IOException("原件在校验期间变化。");digest.update(buffer,0,n);}}
      if(count!=expectedSize||!ShareTransport.hex(digest.digest()).equals(sha)||!before.equals(stamp(source)))throw new IOException("文件内容与校验记录不一致。");
    }catch(java.security.NoSuchAlgorithmException impossible){throw new IOException(impossible);}
    synchronized(verified){verified.put(key,now);while(verified.size()>128)verified.remove(verified.keySet().iterator().next());}return before;
  }
}
