package app.relaydrop;

import org.json.JSONObject;
import org.json.JSONException;
import java.util.Locale;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

final class FilePool {
  static final long MAX_SOURCE=32L*1024*1024;
  static final long MAX_PDF_SOURCE=128L*1024*1024,MAX_VIDEO_SOURCE=512L*1024*1024;
  static final int MAX_TEXT_SOURCE=256*1024, MAX_TEXT_RESPONSE=768*1024;
  static String extension(String name){int at=name.lastIndexOf('.');return at<=0?"":name.substring(at+1).toLowerCase(Locale.US);}
  private static boolean has(String list,String value){return (" "+list+" ").contains(" "+value+" ");}
  static String category(String name){String e=extension(name);if(e.isEmpty())return "other";
    if(has("jpg jpeg png webp gif bmp heic heif avif tif tiff svg ico",e))return "image";
    if(has("txt md markdown log csv tsv json xml yaml yml ini conf",e))return "text";
    if(has("pdf doc docx xls xlsx ppt pptx odt ods odp rtf epub",e))return "document";
    if(has("mp4 mkv mov avi webm m4v 3gp mpeg mpg wmv ts",e))return "video";
    if(has("mp3 wav m4a aac flac ogg opus wma aiff",e))return "audio";
    if(has("zip 7z rar tar gz bz2 xz tgz zst",e))return "archive";return "other";
  }
  static String previewKind(JSONObject file){String ext=extension(file.optString("name"));long size=file.optLong("size",-1);if(size<0)return null;if("text".equals(category(file.optString("name")))&&size<=MAX_TEXT_SOURCE)return "text";if(size==0)return null;if(size<=MAX_SOURCE&&has("jpg jpeg png webp",ext)&&!ext.isEmpty())return "image";if(size<=MAX_PDF_SOURCE&&"pdf".equals(ext))return "pdf";if(size<=MAX_VIDEO_SOURCE&&has("mp4 webm mov m4v 3gp",ext)&&!ext.isEmpty())return "video";return null;}
  static long previewLimit(String kind){return "pdf".equals(kind)?MAX_PDF_SOURCE:"video".equals(kind)?MAX_VIDEO_SOURCE:MAX_SOURCE;}
  static String mediaMime(JSONObject file){String e=extension(file.optString("name"));switch(e){case"mp4":case"m4v":return "video/mp4";case"webm":return "video/webm";case"mp3":return "audio/mpeg";case"m4a":return "audio/mp4";case"wav":return "audio/wav";case"ogg":case"oga":return "audio/ogg";default:return null;}}
  static boolean previewable(JSONObject file){String kind=previewKind(file);return "image".equals(kind)||"pdf".equals(kind)||"video".equals(kind);}
  static JSONObject view(JSONObject file)throws JSONException{return new JSONObject(file.toString()).put("category",category(file.optString("name"))).put("previewable",previewable(file)).put("mediaType",mediaMime(file)==null?JSONObject.NULL:mediaMime(file)).put("previewKind",previewKind(file)==null?JSONObject.NULL:previewKind(file));}
  static byte[] decodeText(byte[] source)throws IOException{
    if(source.length>MAX_TEXT_SOURCE)throw new IOException("文本源文件超过 256 KiB。");Charset charset=StandardCharsets.UTF_8;int offset=0;
    if(source.length>=2&&(source[0]&255)==255&&(source[1]&255)==254){charset=StandardCharsets.UTF_16LE;offset=2;}
    else if(source.length>=2&&(source[0]&255)==254&&(source[1]&255)==255){charset=StandardCharsets.UTF_16BE;offset=2;}
    else if(source.length>=3&&(source[0]&255)==239&&(source[1]&255)==187&&(source[2]&255)==191)offset=3;
    String text=charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(source,offset,source.length-offset)).toString();
    if(text.indexOf('\u0000')>=0)throw new IOException("文本包含不支持的控制内容。");byte[] encoded=text.getBytes(StandardCharsets.UTF_8);if(encoded.length>MAX_TEXT_RESPONSE)throw new IOException("文本预览超过响应限制。");return encoded;
  }
}
