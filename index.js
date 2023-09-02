/* eslint-disable max-lines */
// MIT Licensed (see LICENSE.md).
const execa = require("execa");
const path = require("path");
const mkdirp = require("mkdirp");
const fs = require("fs");
const glob = require("glob");
const rimraf = require("rimraf");
const commandExists = require("command-exists").sync;
const yargs = require("yargs");
const findUp = require("find-up");

const repoRootFile = ".raverie";

const dirs = (() => {
  const repo = path.dirname(findUp.sync(repoRootFile));
  const libraries = path.join(repo, "Code");
  const resources = path.join(repo, "Resources");
  const build = path.join(repo, "Build");
  const prebuiltContent = path.join(build, "PrebuiltContent");
  const includedBuilds = path.join(build, "IncludedBuilds");
  const packages = path.join(build, "Packages");
  const page = path.join(build, "Page");
  const downloads = path.join(build, "Downloads");

  return {
    build,
    downloads,
    includedBuilds,
    libraries,
    packages,
    page,
    prebuiltContent,
    repo,
    resources
  };
})();

const executables = [
  {
    copyToIncludedBuilds: true,
    dir: "Editor",
    name: "RaverieEditor",
    nonResourceDependencies: [
      "Data",
      "Templates",
      repoRootFile
    ],
    prebuild: true,
    resourceLibraries: [
      "FragmentCore",
      "Loading",
      "ZeroCore",
      "UiWidget",
      "EditorUi",
      "Editor",
      "Fallback"
    ],
    vfsOnlyPackage: ["Templates"]
  }
];

const printSizes = (dir) => {
  let list = [];
  try {
    list = fs.readdirSync(dir);
  } catch (err) {
    return 0;
  }
  let size = 0;
  list.forEach((fileName) => {
    const file = path.join(dir, fileName);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      return;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink() && !fs.lstatSync(file).isSymbolicLink()) {
      size += printSizes(file);
    } else {
      size += stat.size;
    }
  });
  if (size > 1024 * 1024) {
    const number = `${size}`;
    const leading = "0".repeat(16 - number.length) + number;
    console.log(leading, dir);
  }
  return size;
};

const tryUnlinkSync = (fullPath) => {
  try {
    fs.unlinkSync(fullPath);
    return true;
  } catch (err) {
    return false;
  }
};

const printIndentedLine = (line, symbol) => {
  const indent = " ".repeat(4);
  console.log(indent + symbol + line);
};

const printErrorLine = (line) => {
  printIndentedLine(line, "- ");
  process.exitCode = 1;
};

const printLogLine = (line) => {
  printIndentedLine(line, "+ ");
};

const parseLines = (str, lineCallback) => {
  let text = str;
  if (text.stack) {
    text = `${text.stack}`;
  } else if (typeof text === "object") {
    text = JSON.stringify(text, null, 2);
  } else {
    text = `${text}`;
  }

  const matches = text.match(/[^\r\n]+/gu);
  if (matches) {
    for (const line of matches) {
      lineCallback(line);
    }
  } else if (text) {
    lineCallback(text);
  }
};

const ensureCommandExists = (command) => {
  if (!commandExists(command)) {
    printErrorLine(`Command '${command}' does not exist`);
    return false;
  }
  return true;
};

const exec = async (executable, args, options) => {
  const result = execa(executable, args, options);
  const readData = (optionsFunc, name) => {
    const strName = `${name}Str`;
    result[strName] = "";
    if (result[name]) {
      result[name].on("data", (data) => {
        const str = data.toString();
        if (optionsFunc) {
          parseLines(str, optionsFunc);
        }
        result[strName] += str;
      });
    }
  };
  readData(options.out, "stdout");
  readData(options.err, "stderr");
  const final = await result;
  return {
    failed: final.failed,
    stderr: result.stderrStr,
    stdout: result.stdoutStr
  };
};

const clearCreateDirectory = (directory) => {
  rimraf.sync(directory);
  mkdirp.sync(directory);
};

// If this fails, it returns an empty string, otherwise it returns trimmed stdout.
const execSimple = async (...args) => {
  const result = await exec(...args);
  if (result.failed) {
    return "";
  }
  return result.stdout.trim();
};

/*
 * Add files to an existing zip. If the file paths are absolute, only the file name will be added to the root,
 * otherwise if the files are relative the entire relative path will be added.
 */
const zipAdd = async (cwd, outputZip, files) => {
  if (files.length === 0) {
    return;
  }
  const options = {
    cwd,
    err: printErrorLine,
    out: printLogLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  await exec("7z", [
    "a",
    "-tzip",
    "-mx=9",
    "-mfb=128",
    "-mpass=10",
    outputZip,
    ...files
  ], options);
};

const zipExtract = async (zipFile, outDir) => {
  const options = {
    err: printErrorLine,
    out: printLogLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  await exec("7z", [
    "x",
    zipFile,
    `-o${outDir}`,
    "-y"
  ], options);
};

const gatherSourceFiles = (directory, extensions) => {
  console.log("Gathering Source Files");
  const files = glob.sync(`**/*.@(${extensions})`, {
    absolute: true,
    cwd: directory
  });

  const filteredFiles = files.filter((filePath) => {
    const code = fs.readFileSync(filePath, "utf8");
    return !code.startsWith("// External.");
  });
  return filteredFiles;
};

const runEslint = async (options) => {
  console.log("Running Eslint");
  const eslintOptions = {
    cwd: dirs.repo,
    err: options.validate ? printErrorLine : printLogLine,
    out: options.validate ? printErrorLine : printLogLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  const eslintPath = path.normalize(path.join(require.resolve("eslint"), "..", "..", "bin", "eslint.js"));
  const args = [
    eslintPath,
    "."
  ];

  if (!options.validate) {
    args.push("--fix");
  }

  await exec("node", args, eslintOptions);
};

const runClangTidy = async (options, sourceFiles) => {
  console.log("Running Clang Tidy");
  if (!ensureCommandExists("clang-tidy")) {
    return;
  }

  // Run clang-tidy.
  const clangTidyOptions = {
    cwd: dirs.libraries,
    reject: false,
    // We only ignore stderr because it prints 'unable to find compile_commands.json'.
    stdio: [
      "ignore",
      "pipe",
      "inherit"
    ]
  };

  for (const filePath of sourceFiles) {
    const oldCode = fs.readFileSync(filePath, "utf8");

    // We always tell it to fix the file, and we compare it afterward to see if it changed.
    const args = [
      "-extra-arg=-Weverything",
      "-fix",
      "-header-filter=.*",
      filePath
    ];

    // Clang-tidy emits all the errors to the stdout (redirect to stderr).
    const result = await exec("clang-tidy", args, clangTidyOptions);

    if (!options.validate) {
      continue;
    }

    const newCode = fs.readFileSync(filePath, "utf8");
    if (oldCode !== newCode) {
      printErrorLine(`File '${filePath}' was not clang-tidy'd`);
      parseLines(result.stdout, printErrorLine);

      // Rewrite the original code back.
      fs.writeFileSync(filePath, oldCode, "utf8");
    }
  }
};

const runClangFormat = async (options, sourceFiles) => {
  console.log("Running Clang Format");
  if (!ensureCommandExists("clang-format")) {
    return;
  }

  const clangFormatOptions = {
    cwd: dirs.libraries,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "ignore"
    ],
    stripEof: false,
    stripFinalNewline: false
  };

  await Promise.all(sourceFiles.map(async (filePath) => {
    const result = await exec("clang-format", [filePath], clangFormatOptions);

    const oldCode = fs.readFileSync(filePath, "utf8");
    const newCode = result.stdout;

    if (oldCode !== newCode) {
      if (options.validate) {
        printErrorLine(`File '${filePath}' was not clang-formatted`);
      } else {
        fs.writeFileSync(filePath, newCode, "utf8");
      }
    }
  }));
};

const runRaverieFormat = async (options, sourceFiles) => {
  console.log("Running Raverie Format");

  await Promise.all(sourceFiles.map(async (filePath) => {
    const oldCode = fs.readFileSync(filePath, "utf8");

    // Split our code into lines (detect Windows newline too so we can remove it).
    const lines = oldCode.split(/\r?\n/u);

    const commentRegex = /^[ \t]*[/*-=\\]+.*/u;

    // Remove any comments from the first lines.
    while (lines.length !== 0) {
      const [line] = lines;
      if (commentRegex.test(line)) {
        lines.shift();
      } else {
        break;
      }
    }

    /*
     * Remove any comments that are long bar comments.
     * Technically this could remove the beginning of a multi-line comment, but our
     * style says it's invalid to have one that has a ton of stars in it anyways.
     */
    const barCommentRegex = /^[ \t]*[/*-=\\]{40}.*/u;

    // These comments may have text after them, but we delete that too intentionally.
    for (let lineIndex = 0; lineIndex < lines.length;) {
      const line = lines[lineIndex];
      if (barCommentRegex.test(line)) {
        lines.splice(lineIndex, 1);
      } else {
        ++lineIndex;
      }
    }

    // Add back in the standard file header (would have been removed above) with a newline after it.
    lines.unshift("// MIT Licensed (see LICENSE.md).");

    // Join all lines together with a standard UNIX newline.
    const newCodeWithoutEnding = lines.join("\n");
    const newCode = newCodeWithoutEnding.endsWith("\n") ? newCodeWithoutEnding : `${newCodeWithoutEnding}\n`;

    if (oldCode !== newCode) {
      if (options.validate) {
        printErrorLine(`File '${filePath}' must be raverie-formatted`);
      } else {
        fs.writeFileSync(filePath, newCode, "utf8");
      }
    }
  }));
};

const determineCmakeCombo = (options) => ({
  config: options.config || "Release",
  vfs: true
});

const activateBuildDir = (combo) => {
  const comboStr =
      `${combo.config}`.
        replace(/ /gu, "-");
  const comboDir = path.join(dirs.build, comboStr);
  mkdirp.sync(comboDir);

  /*
   * This will always be set to the last build directory the user created (when calling cmake/build).
   * This is used for finding compile_commands.json, cmake artefacts, etc.
   */
  const activeLink = path.join(dirs.build, "Active");
  tryUnlinkSync(activeLink);
  fs.symlinkSync(`./${comboStr}`, activeLink, "junction");
  printLogLine(`Activated ${comboStr}`);
  return comboDir;
};

const readCmakeVariables = (buildDir) => {
  const cmakeCachePath = path.join(buildDir, "CMakeCache.txt");
  const contents = fs.readFileSync(cmakeCachePath, "utf8");
  const regex = /(?<name>[a-zA-Z0-9_-]+):UNINITIALIZED=(?<value>.*)/gu;

  const result = {};
  for (;;) {
    const array = regex.exec(contents);
    if (!array) {
      break;
    }
    result[array.groups.name] = array.groups.value;
  }
  return result;
};

const getVersionedPrebuiltContentDir = (cmakeVariables) => {
  // This must match the revisionChangesetName in ContentLogic.cpp:
  const revisionChangesetName = `Version-${cmakeVariables.RAVERIE_REVISION}-${cmakeVariables.RAVERIE_CHANGESET}`;
  return path.join(dirs.prebuiltContent, revisionChangesetName);
};

const makeExecutableZip = async (cmakeVariablesOptional, executable, fileSystemZip) => {
  console.log(`Building zip for ${executable.name}`);
  tryUnlinkSync(fileSystemZip);

  const files = [...executable.nonResourceDependencies];
  for (const resourceLibrary of executable.resourceLibraries) {
    const resourceLibraryPath = path.join(dirs.resources, resourceLibrary);
    if (fs.existsSync(resourceLibraryPath)) {
      files.push(resourceLibraryPath);
    } else {
      printLogLine(`Skipping resource library for ${resourceLibrary}`);
    }

    if (cmakeVariablesOptional) {
      const prebuiltPath = path.join(getVersionedPrebuiltContentDir(cmakeVariablesOptional), resourceLibrary);
      if (fs.existsSync(prebuiltPath)) {
        files.push(prebuiltPath);
      } else {
        printLogLine(`Skipping prebuilt content for ${resourceLibrary}`);
      }
    }
  }

  const relativeFiles = files.map((file) => path.relative(dirs.repo, path.normalize(file)));
  await zipAdd(dirs.repo, fileSystemZip, relativeFiles);
};

const generateBinaryCArray = (id, buffer) => `unsigned char ${id}Data[] = {${buffer.join(",")}};\nunsigned int ${id}Size = ${buffer.length};\n`;

const buildvfs = async (cmakeVariablesOptional, buildDir, combo) => {
  for (const executable of executables) {
    console.log(`Building virtual file system for ${executable.name}`);

    const libraryDir = path.join(buildDir, "Code", executable.dir, executable.name);
    mkdirp.sync(libraryDir);

    const makeFsBuffer = async () => {
      if (combo.vfs) {
        const fileSystemZip = path.join(libraryDir, "FileSystem.zip");
        await makeExecutableZip(cmakeVariablesOptional, executable, fileSystemZip);
        return fs.readFileSync(fileSystemZip);
      }
      return Buffer.alloc(1);
    };

    const vfsCppContents = generateBinaryCArray("VirtualFileSystem", await makeFsBuffer());
    const vfsCppFile = path.join(libraryDir, "VirtualFileSystem.cpp");
    if (!fs.existsSync(vfsCppFile) || fs.readFileSync(vfsCppFile, "utf8") !== vfsCppContents) {
      fs.writeFileSync(vfsCppFile, vfsCppContents, "utf8");
    }
  }
};

const cmake = async (options) => {
  console.log("Running Cmake", options);

  if (!ensureCommandExists("cmake") || !ensureCommandExists("git")) {
    return null;
  }

  const gitOptions = {
    cwd: dirs.repo,
    err: printErrorLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  const branch = await execSimple("git", [
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], gitOptions);
  const revision = await execSimple("git", [
    "rev-list",
    "--count",
    "HEAD"
  ], gitOptions);
  const shortChangeset = await execSimple("git", [
    "log",
    "-1",
    "--pretty=%h",
    "--abbrev=12"
  ], gitOptions);
  const changeset = await execSimple("git", [
    "log",
    "-1",
    "--pretty=%H"
  ], gitOptions);
  const changesetDate = `"${await execSimple("git", [
    "log",
    "-1",
    "--pretty=%cd",
    "--date=format:%Y-%m-%d"
  ], gitOptions)}"`;

  const tag = await execSimple("git", [
    "describe",
    "--tags"
  ], gitOptions);
  const versionResult = (/v(?<major>[0-9]+)\.(?<minor>[0-9]+)\.(?<patch>[0-9]+)/u).exec(tag);
  const version = versionResult ? {
    major: parseInt(versionResult.groups.major, 10),
    minor: parseInt(versionResult.groups.minor, 10),
    patch: parseInt(versionResult.groups.patch, 10)
  } : {major: 0, minor: 0, patch: 0};

  const combo = determineCmakeCombo(options);

  const cmakeArgs = [
    `-DRAVERIE_MS_SINCE_EPOCH=${Date.now()}`,
    `-DRAVERIE_BRANCH=${branch}`,
    `-DRAVERIE_REVISION=${revision}`,
    `-DRAVERIE_SHORT_CHANGESET=${shortChangeset}`,
    `-DRAVERIE_CHANGESET=${changeset}`,
    `-DRAVERIE_CHANGESET_DATE=${changesetDate}`,
    `-DRAVERIE_MAJOR_VERSION=${version.major}`,
    `-DRAVERIE_MINOR_VERSION=${version.minor}`,
    `-DRAVERIE_PATCH_VERSION=${version.patch}`,
    `-DRAVERIE_CONFIG=${combo.config}`,
    "-GNinja",
    `-DCMAKE_BUILD_TYPE=${combo.config}`,
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=1",
    dirs.repo
  ];

  parseLines(cmakeArgs, printLogLine);
  parseLines(combo, printLogLine);

  const buildDir = activateBuildDir(combo);
  //clearCreateDirectory(buildDir);

  await buildvfs(null, buildDir, combo);

  const cmakeOptions = {
    cwd: buildDir,
    err: printErrorLine,
    out: printLogLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  await exec("cmake", cmakeArgs, cmakeOptions);

  return buildDir;
};

const preventNoOutputTimeout = () => {
  const start = Date.now();
  const interval = setInterval(() => {
    printLogLine(`Working... (${Math.floor((Date.now() - start) / 1000)} seconds)`);
  }, 1000 * 10);
  return () => clearInterval(interval);
};

const findExecutableDir = (buildDir, config, libraryDir, library) => [
  path.join(buildDir, "Code", libraryDir, library, config),
  path.join(buildDir, "Code", libraryDir, library)
].filter((filePath) => fs.existsSync(filePath))[0];

const findExecutable = (buildDir, config, libraryDir, library) =>
  path.join(findExecutableDir(buildDir, config, libraryDir, library), library);

const format = async (options) => {
  console.log("Formatting");
  await runEslint(options);
  const sourceFiles = gatherSourceFiles(dirs.libraries, "c|cc|cxx|cpp|h|hxx|hpp|inl");
  if (options.tidy) {
    await runClangTidy(options, sourceFiles);
  }
  await runClangFormat(options, sourceFiles);
  const scriptFiles = gatherSourceFiles(dirs.resources, "zilchscript|z|zilchfrag|zilchFrag");
  const allFiles = sourceFiles.concat(scriptFiles);
  await runRaverieFormat(options, allFiles);
  console.log("Formatted");
};

const build = async (options) => {
  console.log("Building");
  if (!ensureCommandExists("cmake")) {
    return;
  }
  const combo = determineCmakeCombo(options);
  const buildDir = activateBuildDir(combo);

  const cmakeVariables = readCmakeVariables(buildDir);
  await buildvfs(cmakeVariables, buildDir, combo);

  const opts = {
    cwd: buildDir,
    err: printErrorLine,
    out: (line) => {
      if (line.search(/\b(?:FAILED|failed|ERROR| error )\b/u) === -1) {
        printLogLine(line);
      } else {
        printErrorLine(line);
      }
    },
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };

  const makeArgArray = (optsName) => options[optsName] ? [
    `--${optsName}`,
    options[optsName]
  ] : [];

  const target = makeArgArray("target");
  const parallel = makeArgArray("parallel");

  const endPnot = preventNoOutputTimeout();
  await exec("cmake", [
    "--build",
    ".",
    "--config",
    combo.config,
    ...target,
    ...parallel
  ], opts);
  endPnot();
  console.log("Built");
};

const executeBuiltProcess = async (buildDir, combo, libraryDir, library, args) => {
  // TODO(trevor): Retailor this to import the WASM and execute it
  const executablePath = findExecutable(buildDir, combo.config, libraryDir, library);

  if (!fs.existsSync(executablePath)) {
    printErrorLine(`Executable does not exist ${executablePath}`);
    return [];
  }

  const opts = {
    cwd: buildDir,
    err: printLogLine,
    out: printLogLine,
    reject: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe"
    ]
  };
  await exec(executablePath, args, opts);
  return [];
};

const prebuilt = async (options) => {
  console.log("Copying Prebuilt Content");
  const endPnot = preventNoOutputTimeout();
  const combo = determineCmakeCombo(options);
  rimraf.sync(dirs.prebuiltContent);

  const buildDir = activateBuildDir(combo);
  for (const executable of executables) {
    if (!executable.prebuild) {
      continue;
    }

    const downloadPaths = await executeBuiltProcess(buildDir, combo, executable.dir, executable.name, [
      "-CopyPrebuiltContent",
      "-Exit"
    ]);

    for (const downloadPath of downloadPaths) {
      console.log("Extracting download", downloadPath);
      await zipExtract(downloadPath, dirs.prebuiltContent);
    }
  }

  rimraf.sync(dirs.downloads);
  if (!fs.existsSync(dirs.prebuiltContent) || fs.readdirSync(dirs.prebuiltContent).length === 0) {
    printLogLine("Prebuilt content directory did not exist or was empty");
  }
  console.log("Copied Prebuilt Content");
  endPnot();
};

const pack = async (options) => {
  console.log("Packing");
  const combo = determineCmakeCombo(options);
  const buildDir = activateBuildDir(combo);

  const filter = [
    ".pdb",
    ".ilk",
    ".exp",
    ".lib",
    ".wast",
    ".cmake",
    "CMakeFiles",
    "FileSystem.zip",
    "VirtualFileSystem.cpp"
  ];

  clearCreateDirectory(dirs.page);
  // This prevents GitHub from processing our files with Jekyll.
  fs.writeFileSync(path.join(dirs.page, ".nojekyll"), "", "utf8");
  mkdirp.sync(dirs.packages);

  const cmakeVariables = readCmakeVariables(buildDir);

  rimraf.sync(dirs.includedBuilds);
  for (const executable of executables) {
    const library = executable.name;
    console.log(`Packaging library ${library}`);

    const executableDir = findExecutableDir(buildDir, combo.config, executable.dir, library);
    if (!fs.existsSync(executableDir)) {
      printErrorLine(`Library directory does not exist ${executableDir}`);
      continue;
    }
    const files = fs.readdirSync(executableDir).filter((file) => !filter.includes(path.extname(file)) && !filter.includes(file)).
      map((file) => path.join(executableDir, file));

    /*
     * This needs to match index.js:pack/Standalone.cpp:BuildId::Parse/BuildId::GetFullId/BuildVersion.cpp:GetBuildVersionName
     * Application.Branch.Major.Minor.Patch.Revision.ShortChangeset.MsSinceEpoch.Config.Extension
     * Example: RaverieEditor.master.1.5.0.1501.fb02756c46a4.1574702096290.Windows.x86.Release.zip
     */
    const name =
      `${library}.` +
      `${cmakeVariables.RAVERIE_BRANCH}.` +
      `${cmakeVariables.RAVERIE_MAJOR_VERSION}.` +
      `${cmakeVariables.RAVERIE_MINOR_VERSION}.` +
      `${cmakeVariables.RAVERIE_PATCH_VERSION}.` +
      `${cmakeVariables.RAVERIE_REVISION}.` +
      `${cmakeVariables.RAVERIE_SHORT_CHANGESET}.` +
      `${cmakeVariables.RAVERIE_MS_SINCE_EPOCH}.` +
      `${combo.alias}.` +
      `${cmakeVariables.RAVERIE_CONFIG}.zip`;

    const packageZip = path.join(dirs.packages, name);
    tryUnlinkSync(packageZip);

    if (combo.vfs) {
      await zipAdd(dirs.repo, packageZip, executable.vfsOnlyPackage);
    } else {
      await makeExecutableZip(cmakeVariables, executable, packageZip);
    }

    // Keep files as absolute, since we want to only add the file names to the zip.
    await zipAdd(dirs.repo, packageZip, files);

    if (executable.copyToIncludedBuilds) {
      const extractDir = path.join(dirs.includedBuilds, path.basename(packageZip));
      await zipExtract(packageZip, extractDir);
    }

    // For the web we also output a directory (this can be used to publish to github pages).
    const pageLibraryDir = path.join(dirs.page, library);
    mkdirp.sync(pageLibraryDir);
    files.forEach((file) => {
      const basename = path.basename(file);
      fs.copyFileSync(file, path.join(pageLibraryDir, basename));
    });
  }
  console.log("Packed");
};

const deploy = async () => {
  console.log("Deploying");

  if (fs.existsSync(dirs.page)) {
    await execa("npm", [
      "run",
      "deploy-gh-pages"
    ]);
  }

  console.log("Deployed");
};

const documentation = async () => {
  console.log("Running Doxygen");
  if (!ensureCommandExists("doxygen")) {
    return;
  }
  const doxygenOptions = {
    cwd: dirs.repo,
    err: printErrorLine,
    out: printLogLine,
    reject: false,
    stdio: "pipe"
  };
  const doxyFile = fs.readFileSync("./Documentation/Doxyfile", "utf8");
  const libraryNames = fs.readdirSync(dirs.libraries);

  const libraryDirs = libraryNames.
    map((library) => path.join(dirs.libraries, library)).
    filter((fullPath) => fs.statSync(fullPath).isDirectory());

  await Promise.all(libraryDirs.map(async (libraryDir) => {
    const outputDir = `Build/Documentation/${path.basename(libraryDir)}`;
    const warnLog = path.join(outputDir, "warnings.log");
    mkdirp.sync(outputDir);
    const doxyFileSpecific = `${doxyFile}\nINPUT="${libraryDir}"\nOUTPUT_DIRECTORY="${outputDir}"\nWARN_LOGFILE="${warnLog}"`;
    await exec("doxygen", ["-"], {...doxygenOptions, input: doxyFileSpecific});
  }));
};

const disk = () => {
  printSizes(path.parse(process.cwd()).root);
};

const all = async (options) => {
  //await format({...options, validate: true});
  await cmake(options);
  // Build the executable so we can prebuild content
  await build(options);
  await prebuilt(options);
  // Build again so that the VFS will have the prebuilt content
  await build(options);
  await pack(options);
  //await documentation(options);
  // Finally, pack everything up (with included builds and prebuilt content)
  await pack(options);
};

const main = async () => {
  const empty = {
  };
  const comboOptions = "[--alias=...]  [--config] [--vfs=true|false]";
  // eslint-disable-next-line
    yargs.
    command("disk", "Print the approximate size of every directory on disk", empty, disk).
    command("format", "Formats all C/C++ files", empty, format).
    usage("format [--validate]").
    command("cmake", "Generate a cmake project", empty, cmake).
    usage(`cmake ${comboOptions}`).
    command("build", "Build a cmake project", empty, build).
    usage(`build [--target=...] [--parallel=...] ${comboOptions}`).
    command("documentation", "Build generated documentation", empty, documentation).
    usage("documentation").
    command("prebuilt", "Copy prebuilt content", empty, prebuilt).
    usage(`prebuilt ${comboOptions}`).
    command("pack", "Package everything into standalone installable archives", empty, pack).
    usage(`pack ${comboOptions}`).
    command("deploy", "Deploy the packages", empty, deploy).
    usage(`deploy ${comboOptions}`).
    command("all", "Run all the expected commands in order: cmake build prebuilt documentation pack", empty, all).
    usage(`all ${comboOptions}`).
    demand(1).
    help().
    argv;
};
main();
