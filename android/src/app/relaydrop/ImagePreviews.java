package app.relaydrop;

import android.graphics.*;
import android.graphics.pdf.PdfRenderer;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import java.io.*;
import java.util.*;

/** Authenticated caller supplies a bounded local source; only a small derived JPEG leaves this decoder. */
final class ImagePreviews {
  private static final long MAX_PIXELS=40_000_000L;
  static final class Result {final byte[] bytes;final int pages;Result(byte[] bytes,int pages){this.bytes=bytes;this.pages=pages;}}
  private final LinkedHashMap<String,Result> cache=new LinkedHashMap<>(16,.75f,true);
  private int bytes;
  void invalidate(String id){synchronized(cache){Iterator<Map.Entry<String,Result>> it=cache.entrySet().iterator();while(it.hasNext()){Map.Entry<String,Result> entry=it.next();if(entry.getKey().startsWith(id+":")){bytes-=entry.getValue().bytes.length;it.remove();}}}}
  private static void verify(File source,String expectedSha,long maximum)throws IOException{
    String before=PreviewIntegrity.stamp(source);
    try{java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(source)){byte[] buffer=new byte[65536];int n;long total=0;while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new IOException("预览已取消。");total+=n;if(total>maximum)throw new IOException("预览源文件超过限制。");digest.update(buffer,0,n);}}if(!ShareTransport.hex(digest.digest()).equals(expectedSha)||!before.equals(PreviewIntegrity.stamp(source)))throw new IOException("文件内容与校验记录不一致。");}catch(java.security.NoSuchAlgorithmException impossible){throw new IOException(impossible);}
  }
  private static void validDimensions(int width,int height)throws IOException{if(width<1||height<1||(long)width*height>MAX_PIXELS)throw new IOException("文件尺寸不支持预览。");}
  private static Bitmap fit(Bitmap source,int limit){double factor=Math.min(1,(double)limit/Math.max(source.getWidth(),source.getHeight()));int w=Math.max(1,(int)Math.round(source.getWidth()*factor)),h=Math.max(1,(int)Math.round(source.getHeight()*factor));Bitmap result=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(result);canvas.drawColor(Color.WHITE);canvas.drawBitmap(source,null,new Rect(0,0,w,h),new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG));return result;}
  private static Bitmap image(File source,int limit)throws IOException{
    BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(source.getAbsolutePath(),bounds);validDimensions(bounds.outWidth,bounds.outHeight);
    if(!("image/jpeg".equals(bounds.outMimeType)||"image/png".equals(bounds.outMimeType)||"image/webp".equals(bounds.outMimeType)))throw new IOException("图片格式不支持预览。");
    if("image/webp".equals(bounds.outMimeType))try(RandomAccessFile header=new RandomAccessFile(source,"r")){byte[] b=new byte[21];if(header.length()>=21){header.readFully(b);if(b[12]=='V'&&b[13]=='P'&&b[14]=='8'&&b[15]=='X'&&(b[20]&2)!=0)throw new IOException("动态图不生成缩略图。");}}
    BitmapFactory.Options options=new BitmapFactory.Options();options.inSampleSize=1;while(Math.max(bounds.outWidth,bounds.outHeight)/options.inSampleSize>limit*2)options.inSampleSize*=2;options.inPreferredConfig=Bitmap.Config.ARGB_8888;
    Bitmap decoded=BitmapFactory.decodeFile(source.getAbsolutePath(),options);if(decoded==null)throw new IOException("无法解码图片。");
    try{ExifInterface exif=new ExifInterface(source.getAbsolutePath());int orientation=exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL);Matrix matrix=new Matrix();switch(orientation){case 2:matrix.setScale(-1,1);break;case 3:matrix.setRotate(180);break;case 4:matrix.setScale(1,-1);break;case 5:matrix.setRotate(90);matrix.postScale(-1,1);break;case 6:matrix.setRotate(90);break;case 7:matrix.setRotate(-90);matrix.postScale(-1,1);break;case 8:matrix.setRotate(-90);break;default:break;}if(!matrix.isIdentity()){Bitmap oriented=Bitmap.createBitmap(decoded,0,0,decoded.getWidth(),decoded.getHeight(),matrix,true);if(oriented!=decoded)decoded.recycle();decoded=oriented;}}catch(IOException ignored){}catch(RuntimeException|OutOfMemoryError error){decoded.recycle();throw error;}
    return decoded;
  }
  private static Bitmap pdf(File source,int number,int limit,int[] pages)throws IOException{
    ParcelFileDescriptor descriptor=ParcelFileDescriptor.open(source,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=null;Bitmap bitmap=null;
    try{renderer=new PdfRenderer(descriptor);pages[0]=Math.min(1000,renderer.getPageCount());if(number<1||number>pages[0])throw new IOException("PDF 页码超出可预览范围。");try(PdfRenderer.Page page=renderer.openPage(number-1)){validDimensions(page.getWidth(),page.getHeight());double scale=(double)limit/Math.max(page.getWidth(),page.getHeight());int w=Math.max(1,(int)Math.round(page.getWidth()*scale)),h=Math.max(1,(int)Math.round(page.getHeight()*scale));bitmap=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);bitmap.eraseColor(Color.WHITE);Matrix transform=new Matrix();transform.setScale((float)scale,(float)scale);page.render(bitmap,null,transform,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);}Bitmap result=bitmap;bitmap=null;return result;}finally{if(bitmap!=null)bitmap.recycle();if(renderer!=null)renderer.close();else descriptor.close();}
  }
  private static Bitmap video(File source,int limit)throws IOException{
    MediaMetadataRetriever retriever=new MediaMetadataRetriever();try{retriever.setDataSource(source.getAbsolutePath());int width=Integer.parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)),height=Integer.parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));validDimensions(width,height);double factor=Math.min(1,(double)limit/Math.max(width,height));int w=Math.max(1,(int)Math.round(width*factor)),h=Math.max(1,(int)Math.round(height*factor));Bitmap frame;
      if(Build.VERSION.SDK_INT>=27)frame=retriever.getScaledFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,w,h);
      else{if((long)width*height>8_000_000L)throw new IOException("此安卓版本暂不预览超大视频画面。");frame=retriever.getFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);}
      if(frame==null)throw new IOException("视频没有可预览的画面。");return frame;
    }catch(NumberFormatException error){throw new IOException("视频尺寸无效。",error);}finally{retriever.release();}
  }
  synchronized Result generate(File source,String key,String expectedSha,String kind,String mode,int page)throws IOException{
    if(Thread.currentThread().isInterrupted())throw new IOException("预览已取消。");if(!source.isFile()||source.length()<1||source.length()>FilePool.previewLimit(kind))throw new IOException("文件大小不支持预览。");
    // Even cache hits must authenticate the bytes; file timestamps alone cannot establish integrity.
    String stamp=PreviewIntegrity.stamp(source);verify(source,expectedSha,FilePool.previewLimit(kind));synchronized(cache){Result known=cache.get(key);if(known!=null)return known;}
    int limit="detail".equals(mode)?1280:320,maximum="detail".equals(mode)?1024*1024:300*1024;int[] pages={1};
    Bitmap decoded=null,result=null;try{
      if("image".equals(kind))decoded=image(source,limit);else if("pdf".equals(kind))decoded=pdf(source,page,limit,pages);else if("video".equals(kind))decoded=video(source,limit);else throw new IOException("不支持此预览类型。");
      if(Thread.currentThread().isInterrupted())throw new IOException("预览已取消。");result=fit(decoded,limit);ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] data=null;for(int quality:new int[]{82,68,50}){out.reset();if(!result.compress(Bitmap.CompressFormat.JPEG,quality,out))throw new IOException("无法生成预览。");data=out.toByteArray();if(data.length<=maximum)break;}if(data==null||data.length<4||data.length>maximum)throw new IOException("预览超过响应限制。");if(!stamp.equals(PreviewIntegrity.stamp(source)))throw new IOException("预览期间原件发生改变。");Result generated=new Result(data,pages[0]);
      synchronized(cache){cache.put(key,generated);bytes+=data.length;Iterator<Map.Entry<String,Result>> it=cache.entrySet().iterator();while((bytes>16*1024*1024||cache.size()>64)&&it.hasNext()){Map.Entry<String,Result> entry=it.next();bytes-=entry.getValue().bytes.length;it.remove();}}return generated;
    }catch(OutOfMemoryError|RuntimeException error){throw new IOException("文件暂不能预览。",error);}finally{if(result!=null)result.recycle();if(decoded!=null&&decoded!=result)decoded.recycle();}
  }
}
