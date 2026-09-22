import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;

import org.lateralgm.components.impl.ResNode;
import org.lateralgm.file.GMXFileWriter;
import org.lateralgm.file.GmFileReader;
import org.lateralgm.file.ProjectFile;
import org.lateralgm.resources.library.LibManager;

/**
 * LateralGM's "open a .gm6, save it as a .gmx" with no window.
 *
 *   java Gm6ToGmx <in.gm6> <out dir>.gmx <ProjectName> [action library dir]
 *
 * Writes <out dir>.gmx/<ProjectName>.project.gmx and the asset folders beside
 * it, which is the layout GameMaker: Studio 1.4 produces.
 *
 * Three things to know:
 *
 *  - The action libraries have to be loaded first. LGM does it in its startup
 *    (LibManager.autoLoad()); without it every drag-and-drop action in the file
 *    resolves to a null LibAction and the read dies with a NullPointerException
 *    inside readActions. The default libraries ship as .lgl files under
 *    org/lateralgm/resources/library/default.
 *  - ProjectFile.getDirectory() derives the asset root from `uri`, but only by
 *    asking the filesystem for that file's parent -- if the file does not exist
 *    yet it hands back the path *including* the filename, and every asset lands
 *    one level too deep. Opening the output stream first creates the file, so
 *    by the time the writer asks, the answer is right.
 *  - ProjectFile.interfaceProvider defaults to DefaultInterfaceProvider, which
 *    is headless-safe; it is the progress dialog that would not be.
 */
public class Gm6ToGmx {
  private static final String DEFAULT_LIBS = "org/lateralgm/resources/library/default";

  public static void main(String[] args) throws Exception {
    if (args.length < 3) {
      System.err.println("Usage: Gm6ToGmx <in.gm6> <out.gmx dir> <ProjectName> [lib dir]");
      System.exit(2);
    }

    File source = new File(args[0]).getAbsoluteFile();
    File outDir = new File(args[1]).getAbsoluteFile();
    String name = args[2];
    File libs = new File(args.length > 3 ? args[3] : DEFAULT_LIBS).getAbsoluteFile();

    if (!source.isFile()) {
      System.err.println("Not a file: " + source);
      System.exit(2);
    }
    if (!libs.isDirectory()) {
      System.err.println("No action libraries at: " + libs);
      System.exit(2);
    }

    if (!outDir.isDirectory() && !outDir.mkdirs()) {
      System.err.println("Could not create: " + outDir);
      System.exit(1);
    }

    System.out.println("Libraries " + libs);
    LibManager.autoLoad(libs);

    File project = new File(outDir, name + ".project.gmx");

    ProjectFile file = new ProjectFile();
    ResNode root = new ResNode("Root", (byte) 0, null, null);

    System.out.println("Reading   " + source);
    FileInputStream in = new FileInputStream(source);
    try {
      GmFileReader.readProjectFile(in, file, source.toURI(), root);
    } finally {
      in.close();
    }

    System.out.println("Writing   " + project);
    file.uri = project.toURI();
    OutputStream out = new FileOutputStream(project);
    try {
      GMXFileWriter.writeProjectFile(out, file, root);
    } finally {
      out.close();
    }

    System.out.println("Wrote     " + project + " (" + project.length() + " bytes)");
  }
}
