import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import javax.swing.JTextField;

/**
 * The decompiler's "GM6 EXE -> .gm6" path, with no window.
 *
 * GmDecompilerCli in game/original/GMDecompilerDecompiled cannot do this on its
 * own: GmDecompiler.getSourceFile() reads the GUI's text field, and
 * GmExtractor.extractStandalone calls it to decide where the game's included
 * files (bass.dll, bgm.dll, Music/, Voice/, BG/) go. Left unset it is null, and
 * the run dies with a NullPointerException after writing an empty .gm6.
 *
 * So this launcher fills that field in instead of building the window. Swing
 * components construct fine headless -- only showing one would fail -- and
 * updateProgress already falls back to stdout when there is no progress dialog.
 *
 * Compiled alongside the decompiler's own sources (it is in their default
 * package) by virt/decompile.sh, in a container -- this step needs no VM.
 *
 *   java Decompile <path-to-exe>
 *
 * writes <path-to-exe-without-.exe>.gm6 and the included files beside it.
 */
public class Decompile {
  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("Usage: Decompile <path-to-exe>");
      System.exit(2);
    }

    File source = new File(args[0]).getAbsoluteFile();
    if (!source.isFile()) {
      System.err.println("Not a file: " + source);
      System.exit(2);
    }

    // What getSourceFile() reads.
    GmDecompiler.sourceField = new JTextField(source.getAbsolutePath());

    int versionIdx = GmDecompilerCli.detectExeVersion(source);
    System.out.println("Source: " + source);
    System.out.println("Exe version index: " + versionIdx);
    if (versionIdx != 1) {
      // 0 is a GM5-era .gmd, 2 an Instant Play package; Barkley v1.20 is a
      // plain GM6 standalone, which is index 1. Anything else here means the
      // input is not the exe this pipeline was built for.
      System.err.println("Expected a GM6 standalone exe (index 1), got " + versionIdx);
      System.exit(1);
    }

    File target = new File(source.getPath().replaceFirst("(?i)\\.exe$", "") + ".gm6");
    FileInputStream in = new FileInputStream(source);
    FileOutputStream out = new FileOutputStream(target);
    try {
      GmExtractor.extractStandalone(in, out, true);
    } finally {
      in.close();
      out.close();
    }

    System.out.println("Wrote: " + target + " (" + target.length() + " bytes)");
  }
}
