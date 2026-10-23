package app.relaydrop;

import org.json.JSONObject;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Portable backup-v2 crypto only. Callers own streams, storage rollback and password UI. */
final class EncryptedBackup {
  static final int CHUNK=1048576,ITERATIONS=600000,MAX_MANIFEST=16*1048576;
  static final long MAX_FILE=20L*1024*1048576;
  private static final byte[] MAGIC="RDBK2GCM".getBytes(StandardCharsets.US_ASCII);
  private static final SecureRandom RANDOM=new SecureRandom();
  static final class BackupException extends IOException {
    final String code;
    BackupException(String code,String message){super(message);this.code=code;}
  }
  static final class Context implements AutoCloseable {
    final byte[] headerBytes,key;
    final String headerHash;
    private boolean closed;
    Context(byte[] header,byte[] key)throws Exception{this.headerBytes=header.clone();this.key=key;headerHash=hex(MessageDigest.getInstance("SHA-256").digest(header));}
    void requireOpen()throws IOException{if(closed)throw new IOException("加密备份会话已结束。");}
    public void close(){if(!closed){closed=true;Arrays.fill(key,(byte)0);}}
  }
  static final class Result {final long size;final String sha256;Result(long size,String sha256){this.size=size;this.sha256=sha256;}}
  private static BackupException invalid(){return new BackupException("INVALID_BACKUP","加密备份格式或参数无效。");}
  private static BackupException authentication(){return new BackupException("BACKUP_AUTH_FAILED","密码错误或加密备份已损坏，未恢复任何文件。");}
  private static void check(PoolBackup.Progress progress)throws IOException{if(progress!=null)progress.check();}
  private static String hex(byte[] bytes){char[] text=new char[bytes.length*2],digits="0123456789abcdef".toCharArray();for(int i=0;i<bytes.length;i++){text[i*2]=digits[(bytes[i]&255)>>>4];text[i*2+1]=digits[bytes[i]&15];}return new String(text);}
  private static byte[] passwordBytes(char[] password)throws IOException{
    if(password==null||password.length==0)throw new BackupException("PASSWORD_REQUIRED","请输入加密备份密码。");
    if(password.length>1024)throw new BackupException("INVALID_PASSWORD","备份密码须为 8–1024 个 UTF-8 字节。");
    ByteBuffer encoded=null;byte[] result=null;
    try{encoded=StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(password));result=new byte[encoded.remaining()];encoded.get(result);if(result.length<8||result.length>1024){Arrays.fill(result,(byte)0);throw new BackupException("INVALID_PASSWORD","备份密码须为 8–1024 个 UTF-8 字节。");}return result;}
    catch(CharacterCodingException error){throw new BackupException("INVALID_PASSWORD","备份密码含有无效的 Unicode 字符。");}
    finally{if(encoded!=null&&encoded.hasArray())Arrays.fill(encoded.array(),(byte)0);}
  }
  // Explicit UTF-8 PBKDF2 avoids provider-dependent PBEKeySpec character conversions.
  static byte[] deriveKey(char[] password,byte[] salt,PoolBackup.Progress progress)throws Exception{
    if(salt==null||salt.length!=32)throw invalid();byte[] secret=passwordBytes(password),u=null,result=null,block=Arrays.copyOf(salt,36);block[35]=1;boolean complete=false;
    try{check(progress);Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret,"HmacSHA256"));u=mac.doFinal(block);result=u.clone();for(int round=1;round<ITERATIONS;round++){if((round&1023)==0)check(progress);byte[] next=mac.doFinal(u);Arrays.fill(u,(byte)0);u=next;for(int j=0;j<result.length;j++)result[j]^=u[j];}check(progress);complete=true;return result;}
    finally{Arrays.fill(secret,(byte)0);Arrays.fill(block,(byte)0);if(u!=null)Arrays.fill(u,(byte)0);if(!complete&&result!=null)Arrays.fill(result,(byte)0);}
  }
  static Context create(char[] password,PoolBackup.Progress progress)throws Exception{
    byte[] salt=new byte[32];RANDOM.nextBytes(salt);
    try{byte[] header=(new JSONObject().put("format","relaydrop-encrypted-backup").put("version",2).put("kdf","PBKDF2-HMAC-SHA256").put("iterations",ITERATIONS).put("salt",Base64.getEncoder().encodeToString(salt)).put("chunkSize",CHUNK).toString()+"\n").getBytes(StandardCharsets.UTF_8);return new Context(header,deriveKey(password,salt,progress));}
    finally{Arrays.fill(salt,(byte)0);}
  }
  static Context open(byte[] headerBytes,char[] password,PoolBackup.Progress progress)throws Exception{
    if(headerBytes==null||headerBytes.length>4096)throw invalid();byte[] salt=null;
    try{
      String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(headerBytes)).toString();JSONObject header=new JSONObject(text);
      Set<String> fields=new HashSet<>(Arrays.asList("format","version","kdf","iterations","salt","chunkSize"));Iterator<String> keys=header.keys();while(keys.hasNext())if(!fields.remove(keys.next()))throw invalid();
      if(!fields.isEmpty()||header.length()!=6||!"relaydrop-encrypted-backup".equals(header.opt("format"))||!"PBKDF2-HMAC-SHA256".equals(header.opt("kdf"))||!integer(header.opt("version"),2)||!integer(header.opt("iterations"),ITERATIONS)||!integer(header.opt("chunkSize"),CHUNK)||!(header.opt("salt") instanceof String))throw invalid();
      String encoded=header.getString("salt");salt=Base64.getDecoder().decode(encoded);if(salt.length!=32||!Base64.getEncoder().encodeToString(salt).equals(encoded))throw invalid();
    }catch(BackupException error){throw error;}catch(Exception error){if(salt!=null)Arrays.fill(salt,(byte)0);throw invalid();}
    try{return new Context(headerBytes,deriveKey(password,salt,progress));}finally{Arrays.fill(salt,(byte)0);}
  }
  private static boolean integer(Object value,long expected){return value instanceof Number&&((Number)value).longValue()==expected&&((Number)value).doubleValue()==expected;}
  private static long maximum(String entry,long size,String sha)throws IOException{
    boolean manifest="manifest".equals(entry);if(!manifest&&(entry==null||!entry.matches("file:[a-fA-F0-9-]{36}")))throw invalid();long max=manifest?MAX_MANIFEST:MAX_FILE;
    if(size<0&&!manifest||size< -1||size>max||sha!=null&&!sha.matches("[a-f0-9]{64}")||!manifest&&sha==null)throw invalid();return max;
  }
  private static byte[] aad(Context context,String entry,long sequence,int length){return("RelayDrop-Backup-v2\n"+context.headerHash+"\n"+entry+"\n"+sequence+"\n"+length+"\n").getBytes(StandardCharsets.UTF_8);}
  private static void writeRecord(DataOutputStream out,byte[] bytes,int length,Context context,String entry,long sequence)throws Exception{
    byte[] nonce=new byte[12];RANDOM.nextBytes(nonce);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(context.key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aad(context,entry,sequence,length));byte[] sealed=cipher.doFinal(bytes,0,length);try{out.writeInt(length);out.write(nonce);out.write(sealed);}finally{Arrays.fill(sealed,(byte)0);}
  }
  static Result encrypt(InputStream input,OutputStream output,Context context,String entry,long expectedSize,String expectedSha256,PoolBackup.Progress progress)throws Exception{
    if(input==null||output==null)throw new IOException("无法读取原件或写入加密备份。");context.requireOpen();long max=maximum(entry,expectedSize,expectedSha256),total=0,sequence=0;MessageDigest hash=MessageDigest.getInstance("SHA-256");DataOutputStream out=new DataOutputStream(output);byte[] buffer=new byte[CHUNK];out.write(MAGIC);
    try{for(;;){check(progress);int used=0;while(used<buffer.length){int count=input.read(buffer,used,buffer.length-used);if(count<0)break;if(count==0){int one=input.read();if(one<0)break;buffer[used++]=(byte)one;}else used+=count;check(progress);}if(used==0)break;total+=used;if(total>max||expectedSize>=0&&total>expectedSize)throw new BackupException("FILE_HASH_MISMATCH","原文件大小与校验记录不一致。");hash.update(buffer,0,used);writeRecord(out,buffer,used,context,entry,sequence++);Arrays.fill(buffer,0,used,(byte)0);}
      String sha=hex(hash.digest());if(expectedSize>=0&&total!=expectedSize||expectedSha256!=null&&!expectedSha256.equals(sha))throw new BackupException("FILE_HASH_MISMATCH","原文件与校验记录不一致。");check(progress);writeRecord(out,buffer,0,context,entry,sequence);out.flush();return new Result(total,sha);
    }finally{Arrays.fill(buffer,(byte)0);}
  }
  static Result decrypt(InputStream input,OutputStream outputOrNull,Context context,String entry,long expectedSize,String expectedSha256,PoolBackup.Progress progress)throws Exception{
    if(input==null)throw new IOException("无法读取加密备份。");context.requireOpen();long max=maximum(entry,expectedSize,expectedSha256),total=0,sequence=0;DataInputStream in=new DataInputStream(input);MessageDigest hash=MessageDigest.getInstance("SHA-256");
    try{byte[] magic=new byte[8];in.readFully(magic);if(!Arrays.equals(magic,MAGIC))throw authentication();for(;;){check(progress);int length=in.readInt();if(length<0||length>CHUNK||total+length>max||expectedSize>=0&&total+length>expectedSize)throw authentication();byte[] nonce=new byte[12],sealed=new byte[length+16],bytes=null;in.readFully(nonce);in.readFully(sealed);
        try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(context.key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aad(context,entry,sequence++,length));try{bytes=cipher.doFinal(sealed);}catch(GeneralSecurityException error){throw authentication();}if(bytes.length!=length)throw authentication();if(length==0){if(in.read()!=-1)throw authentication();break;}total+=length;hash.update(bytes);check(progress);if(outputOrNull!=null)outputOrNull.write(bytes);}
        finally{Arrays.fill(sealed,(byte)0);if(bytes!=null)Arrays.fill(bytes,(byte)0);}
      }String sha=hex(hash.digest());if(expectedSize>=0&&total!=expectedSize||expectedSha256!=null&&!expectedSha256.equals(sha))throw authentication();check(progress);if(outputOrNull!=null)outputOrNull.flush();return new Result(total,sha);
    }catch(EOFException error){throw authentication();}
  }
}