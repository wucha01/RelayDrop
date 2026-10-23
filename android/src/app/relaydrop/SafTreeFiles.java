package app.relaydrop;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.IOException;
import java.util.*;

/** User-granted document trees only. No provider path is ever treated as a local path. */
final class SafTreeFiles {
  static final int MAX_FILES=300,MAX_DEPTH=32,MAX_NODES=2000;
  static final class Entry {final Uri uri;final String path;final boolean directory;Entry(Uri uri,String path,boolean directory){this.uri=uri;this.path=path;this.directory=directory;}}
  static String segment(String value)throws IOException {
    if(value!=null)value=java.text.Normalizer.normalize(value,java.text.Normalizer.Form.NFC);
    if(value==null||!wellFormed(value)||value.isEmpty()||value.length()>128||!value.equals(value.trim())||value.equals(".")||value.equals("..")||value.matches("(?s).*[\\x00-\\x1f\\x7f/\\\\:*?\"<>|].*")||value.endsWith(".")||value.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\\..*)?"))throw new IOException("目录包含不支持的名称，请先重命名："+(value==null?"":value));return value;
  }
  static boolean wellFormed(String value){for(int i=0;i<value.length();i++){char c=value.charAt(i);if(Character.isHighSurrogate(c)){if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i)))return false;}else if(Character.isLowSurrogate(c))return false;}return true;}
  static String path(String value)throws IOException {if(value==null||value.length()>1024)throw new IOException("目录路径过长。");String[] parts=value.split("/",-1);if(parts.length>MAX_DEPTH)throw new IOException("目录层级超过 32 层。");for(int i=0;i<parts.length;i++)parts[i]=segment(parts[i]);return String.join("/",parts);}
  static List<Entry> scan(ContentResolver resolver,Uri tree)throws IOException {
    if(tree==null||!"content".equals(tree.getScheme())||!DocumentsContract.isTreeUri(tree))throw new IOException("请选择系统授权的文件夹。");
    String id=DocumentsContract.getTreeDocumentId(tree);Uri root=DocumentsContract.buildDocumentUriUsingTree(tree,id);String rootName;
    try(Cursor c=resolver.query(root,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)){if(c==null||!c.moveToFirst()||!DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)))throw new IOException("所选位置不是文件夹。");rootName=segment(c.getString(0));}
    List<Entry> out=new ArrayList<>();Set<String> visited=new HashSet<>();int[] files={0};out.add(new Entry(root,rootName,true));walk(resolver,tree,id,rootName,1,out,visited,files);return out;
  }
  private static void walk(ContentResolver resolver,Uri tree,String parent,String prefix,int depth,List<Entry> out,Set<String> visited,int[] files)throws IOException {
    if(Thread.currentThread().isInterrupted())throw new IOException("已取消读取目录。");if(depth>MAX_DEPTH||!visited.add(parent))throw new IOException("目录层级过深或包含循环引用。");
    Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,parent);List<Entry> nested=new ArrayList<>();Set<String> names=new HashSet<>();
    try(Cursor c=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)){
      if(c==null)throw new IOException("无法读取目录内容。");while(c.moveToNext()){if(out.size()+nested.size()>=MAX_NODES)throw new IOException("一次最多读取 2,000 个目录项目。");String id=c.getString(0),name=segment(c.getString(1));if(!names.add(name.toLowerCase(Locale.ROOT)))throw new IOException("目录中有大小写冲突的名称："+name);boolean directory=DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));String relative=path(prefix+"/"+name);Uri uri=DocumentsContract.buildDocumentUriUsingTree(tree,id);nested.add(new Entry(uri,relative,directory));if(!directory&&++files[0]>MAX_FILES)throw new IOException("一次最多发送 300 个文件，请分批选择子目录。");}
    }catch(SecurityException error){throw new IOException("目录授权已失效，请重新选择。",error);}
    nested.sort(Comparator.comparing(e->e.path));for(Entry e:nested){out.add(e);if(e.directory)walk(resolver,tree,DocumentsContract.getDocumentId(e.uri),e.path,depth+1,out,visited,files);}
  }
  static Uri root(Uri tree){return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));}
  static Uri find(ContentResolver resolver,Uri tree,Uri parent,String name)throws IOException {
    PoolBackup.payloadPath("files/"+name);Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(parent));Uri result=null;
    try(Cursor c=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c==null)throw new IOException("无法读取备份目录。");while(c.moveToNext())if(name.equals(c.getString(1))){if(result!=null)throw new IOException("目录包含重复名称。");result=DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));}}return result;
  }
  static Uri resolve(ContentResolver resolver,Uri tree,String relative)throws IOException {path(relative);Uri current=root(tree);for(String p:relative.split("/")){current=find(resolver,tree,current,p);if(current==null)throw new IOException("备份文件缺失："+relative);}return current;}
  static Uri create(ContentResolver resolver,Uri tree,Uri parent,String name,boolean directory)throws IOException {
    PoolBackup.payloadPath("files/"+name);if(find(resolver,tree,parent,name)!=null)throw new IOException("目标已存在，未覆盖："+name);Uri created=DocumentsContract.createDocument(resolver,parent,directory?DocumentsContract.Document.MIME_TYPE_DIR:"application/octet-stream",name);if(created==null)throw new IOException("无法创建："+name);return created;
  }
}
