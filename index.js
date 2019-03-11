// MIT Licensed (see LICENSE.md).
const execa = require('execa');
const path = require('path');
const mkdirp = require('mkdirp');
const fs = require('fs');
const glob = require('glob');
const os = require('os');
const rimraf = require('rimraf');
const commandExists = require('command-exists').sync;

let system;
let executableExtension = '';

function initialize()
{
  switch (os.platform())
  {
  case 'win32':
    system = 'windows';
    executableExtension = '.exe';
    break;
  case 'darwin':
    system = 'mac';
    break;
  default:
    system = 'linux';
    break;
  }
}

initialize();

const dirs = (() =>
{
  const repo = process.cwd();
  const libraries = path.join(repo, 'Libraries');
  const buildPath = path.join(repo, 'Build');

  return {
    repo,
    libraries,
    build: buildPath,
  };
})();

function makeDir(dirPath)
{
  mkdirp.sync(dirPath, {
    recursive: true
  });
  return dirPath;
}

function sleep(ms)
{
  return new Promise(resolve =>
  {
    setTimeout(resolve, ms);
  });
}

function printIndented(text, printer, symbol)
{
  if (!text)
  {
    return;
  }

  if (text.stack)
  {
    text = `${text.stack}`;
  }
  else
  {
    text = `${text}`;
  }

  const indent = ' '.repeat(8) + symbol;
  const matches = text.match(/[^\r\n]+/g);
  if (matches)
  {
    for (const line of matches)
    {
      printer(indent + line);
    }
  }
  else if (text)
  {
    printer(indent + text);
  }
}

function printError(text)
{
  printIndented(text, console.error, '- ');
}

function printLog(text)
{
  printIndented(text, console.log, '+ ');
}

async function exec(executable, args, options)
{
  // A file may be locked after it completes downloading.
  // This may be a result of a virus scanner or other process.
  let lastErr = 'Unknown';
  let result = null;

  const readData = (optionsFunc, name) =>
  {
    const strName = name + 'Str';
    result[strName] = '';
    result[name].on('data', data =>
    {
      const str = data.toString();
      if (optionsFunc)
      {
        optionsFunc(str);
      }
      result[strName] += str;
    });
  };

  for (let attempts = 10; attempts >= 0; --attempts)
  {
    try
    {
      result = execa(executable, args, options);
      readData(options.out, 'stdout');
      readData(options.err, 'stderr');
      await result;
      break;
    }
    catch (err)
    {
      lastErr = err;
      await sleep(100);
      continue;
    }
  }

  if (!result)
  {
    printError(lastErr);
  }
  return {
    stdout: result.stdoutStr,
    stderr: result.stderrStr,
  };
}

async function execStdout(...args)
{
  return (await exec(...args)).stdout;
}

async function execStdoutTrimmed(...args)
{
  return (await execStdout(...args)).trim();
}

function gatherSourceFiles()
{
  console.log('Gathering Source Files');
  const files = glob.sync('**/*.@(c|cc|cxx|cpp|h|hxx|hpp|inl)', {
    cwd: dirs.libraries
  });

  for (let i = 0; i < files.length;)
  {
    const fullPath = path.join(dirs.libraries, files[i]);
    const fileOptions =
    {
      encoding: 'utf8'
    };
    const code = fs.readFileSync(fullPath, fileOptions);

    if (code.startsWith('// External.'))
    {
      files.splice(i, 1);
    }
    else
    {
      ++i;
    }
  }
  return files;
}

async function runEslint(options)
{
  console.log('Running Eslint');
  const eslintOptions = {
    cwd: dirs.repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    out: options.validate ? printError : printLog,
    err: options.validate ? printError : printLog,
    reject: false
  };
  const args = ['node_modules/eslint/bin/eslint.js', '.'];

  if (!options.validate)
  {
    args.push('--fix');
  }

  await exec('node', ['node_modules/eslint/bin/eslint.js', '.'], eslintOptions);
}

async function runClangTidy(options, sourceFiles)
{
  console.log('Running Clang Tidy');
  if (!commandExists('clang-tidy'))
  {
    return;
  }

  // Run clang-tidy.
  const clangTidyOptions = {
    cwd: dirs.libraries,
    // We only ignore stderr because it prints 'unable to find compile_commands.json'.
    stdio: ['ignore', 'pipe', 'inherit'],
    reject: false
  };
  for (const filePath of sourceFiles)
  {
    const fileOptions =
    {
      encoding: 'utf8'
    };
    const fullPath = path.join(dirs.libraries, filePath);
    const oldCode = fs.readFileSync(fullPath, fileOptions);

    // We always tell it to fix the file, and we compare it afterward to see if it changed.
    const args = ['-extra-arg=-Weverything', '-fix'/*, '-p='*/, '-header-filter=.*', filePath];

    // Clang-tidy emits all the errors to the standard out.
    // We capture them and re-emit them to stderr.
    const result = await exec('clang-tidy', args, clangTidyOptions);

    if (!options.validate)
    {
      continue;
    }

    const newCode = fs.readFileSync(fullPath, fileOptions);
    if (oldCode !== newCode)
    {
      printError(`File '${fullPath}' was not clang-tidy'd`);
      printError(result.stdout);

      // Rewrite the original code back.
      fs.writeFileSync(fullPath, oldCode, fileOptions);
    }
  }
}

async function runClangFormat(options, sourceFiles)
{
  console.log('Running Clang Format');
  if (!commandExists('clang-format'))
  {
    return;
  }

  const clangFormatOptions = {
    cwd: dirs.libraries,
    stdio: ['ignore', 'pipe', 'ignore'],
    reject: false,
    stripFinalNewline: false,
    stripEof: false
  };

  for (const filePath of sourceFiles)
  {
    // Clang-format emits the formatted file to the output.
    // In this build script we want to emit errors if the user
    // did not auto-format their code, so we will perform a diff.
    const result = await exec('clang-format', [filePath], clangFormatOptions);

    const fullPath = path.join(dirs.libraries, filePath);
    const fileOptions =
    {
      encoding: 'utf8'
    };
    const oldCode = fs.readFileSync(fullPath, fileOptions);
    const newCode = result.stdout;

    if (options.validate)
    {
      printError(`File '${fullPath}' was not clang-formatted`);
    }
    else if (oldCode !== newCode)
    {
      fs.writeFileSync(fullPath, newCode, fileOptions);
    }
  }
}

async function runWelderFormat(options, sourceFiles)
{
  console.log('Running Welder Format');

  for (const filePath of sourceFiles)
  {
    const fullPath = path.join(dirs.libraries, filePath);
    const fileOptions =
    {
      encoding: 'utf8'
    };
    const oldCode = fs.readFileSync(fullPath, fileOptions);

    // Split our code into lines (detect Windows newline too so we can remove it).
    const lines = oldCode.split(/\r?\n/);

    const commentRegex = /^[/*-=\\]+.*/;

    // Remove any comments from the first lines.
    while (lines.length !== 0)
    {
      const line = lines[0];
      if (commentRegex.test(line))
      {
        lines.shift();
      }
      else
      {
        break;
      }
    }

    // Remove any comments that are long bar comments.
    // Technically this could remove the beginning of a multi-line comment, but our
    // style says it's invalid to have one that has a ton of stars in it anyways.
    const barCommentRegex = /^[/*-=\\]{40}.*/;

    // These comments may have text after them, but we delete that too intentionally.
    for (let i = 0; i < lines.length;)
    {
      const line = lines[i];
      if (barCommentRegex.test(line))
      {
        lines.splice(i, 1);
      }
      else
      {
        ++i;
      }
    }

    // Add back in the standard file header (would have been removed above).
    lines.unshift('// MIT Licensed (see LICENSE.md).');

    // Join all lines together with a standard UNIX newline.
    const newCode = lines.join('\n');

    if (options.validate)
    {
      printError(`File '${fullPath}' must be welder-formatted`);
    }
    else if (oldCode !== newCode)
    {
      fs.writeFileSync(fullPath, newCode, fileOptions);
    }
  }
}

/*
async function runDoxygen()
{
  console.log('Running Doxygen');
  if (!commandExists(paths.doxygen))
  {
    return;
  }

  const doxygenOptions = {
    cwd: dirs.repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    out: printLog,
    err: printError,
    reject: false
  };
  await exec(paths.doxygen, [], doxygenOptions);
}
*/

function determineCmakeCombo(options)
{
  const aliases =
  {
    windows:
    {
      builder: 'Visual Studio 15 2017',
      toolchain: 'MSVC',
      platform: 'Windows',
      architecture: 'X64',
      configuration: 'Any',
    },
    linux:
    {
      builder: 'Ninja',
      toolchain: 'Clang',
      platform: 'SDLSTDEmpty',
      architecture: 'ANY',
      configuration: 'Release',
    },
    emscripten:
    {
      builder: 'MinGW Makefiles',
      toolchain: 'Emscripten',
      platform: 'Emscripten',
      architecture: 'WASM',
      configuration: 'Release',
    },
    empty:
    {
      builder: 'Ninja',
      toolchain: 'Clang',
      platform: 'Stub',
      architecture: 'ANY',
      configuration: 'Release',
    },
  };

  const combo = aliases[options.alias ? options.alias : system];

  // Allow options to override builder, toolchian, etc.
  // It is the user's responsibility to ensure this is a valid combination.
  return Object.assign(combo, options);
}

function determineBuildDir(combo)
{
  const comboString = `${combo.builder}_${combo.toolchain}_${combo.platform}_${combo.architecture}_${combo.configuration}`.replace(/ /g, '-');
  return path.join(dirs.build, comboString);
}

async function runCmake(options)
{
  console.log('Running Cmake', options);

  rimraf.sync(dirs.build);
  makeDir(dirs.build);

  if (!commandExists('cmake') || !commandExists('git'))
  {
    return null;
  }

  const gitOptions = {
    cwd: dirs.repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    err: printError,
    reject: false
  };
  const revision = await execStdoutTrimmed('git', ['rev-list', '--count', 'HEAD'], gitOptions);
  const shortChangeset = await execStdoutTrimmed('git', ['log', '-1', '--pretty=%h', '--abbrev=12'], gitOptions);
  const changeset = await execStdoutTrimmed('git', ['log', '-1', '--pretty=%H'], gitOptions);
  const changesetDate = `"${await execStdoutTrimmed('git', ['log', '-1', '--pretty=%cd', '--date=format:%Y-%m-%d'], gitOptions)}"`;


  let builderArgs = [];
  let toolchainArgs = [];
  let architectureArgs = [];
  let configurationArgs = [];

  const combo = determineCmakeCombo(options);

  if (combo.builder === 'Ninja')
  {
    builderArgs = [
      '-DCMAKE_MAKE_PROGRAM=ninja',
    ];
  }

  if (combo.toolchain === 'Emscripten')
  {
    if (!process.env.EMSCRIPTEN)
    {
      printError('Cannot find EMSCRIPTEN environment variable');
    }

    const toolchainFile = path.join(process.env.EMSCRIPTEN, 'cmake/Modules/Platform/Emscripten.cmake');
    toolchainArgs = [
      `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
      '-DEMSCRIPTEN_GENERATE_BITCODE_STATIC_LIBRARIES=1',
    ];
  }

  if (combo.toolchain === 'Clang')
  {
    toolchainArgs = [
      '-DCMAKE_SYSTEM_NAME=Generic',
      '-DCMAKE_C_COMPILER:PATH=clang',
      '-DCMAKE_CXX_COMPILER:PATH=clang++',
      '-DCMAKE_C_COMPILER_ID=Clang',
      '-DCMAKE_CXX_COMPILER_ID=Clang',
      '-DCMAKE_LINKER=lld',
      '-DCMAKE_AR=/usr/bin/llvm-ar',
    ];
  }

  if (combo.toolchain === 'MSVC' && combo.architecture === 'X64')
  {
    architectureArgs = [
      '-DCMAKE_GENERATOR_PLATFORM=x64',
      '-T', 'host=x64',
    ];
  }

  if (combo.toolchain !== 'MSVC')
  {
    configurationArgs = [
      `-DCMAKE_BUILD_TYPE=${combo.configuration}`,
      '-DCMAKE_EXPORT_COMPILE_COMMANDS=1',
    ];
  }

  const cmakeArgs = [
    `-DWELDER_REVISION=${revision}`,
    `-DWELDER_SHORT_CHANGESET=${shortChangeset}`,
    `-DWELDER_CHANGESET=${changeset}`,
    `-DWELDER_CHANGESET_DATE=${changesetDate}`,
    '-G', combo.builder,
    ...builderArgs,
    `-DWELDER_TOOLCHAIN=${combo.toolchain}`,
    ...toolchainArgs,
    `-DWELDER_PLATFORM=${combo.platform}`,
    `-DWELDER_ARCHITECTURE=${combo.architecture}`,
    ...architectureArgs,
    ...configurationArgs,
    dirs.repo,
  ];

  console.log(cmakeArgs);
  console.log(combo);

  const comboDir = determineBuildDir(combo);
  rimraf.sync(comboDir);
  makeDir(comboDir);

  const cmakeOptions = {
    cwd: comboDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    out: printLog,
    err: printError,
    reject: false
  };
  await exec('cmake', cmakeArgs, cmakeOptions);

  return comboDir;
}

function safeChmod(file, mode)
{
  try
  {
    fs.chmodSync(file, mode);
  }
  catch (err)
  {
    printError(err);
  }
}

async function runBuild(buildDir, config, testExecutablePaths)
{
  console.log('Running Build');
  if (!commandExists('cmake'))
  {
    return;
  }

  const options = {
    cwd: buildDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    out: text =>
    {
      if (text.search(/(FAILED|failed|ERROR)/) === -1)
      {
        printLog(text);
      }
      else
      {
        printError(text);
      }
    },
    err: printError,
    reject: false
  };

  await exec('cmake', ['--build', '.', '--config', config], options);

  const addExecutable = file =>
  {
    if (fs.existsSync(file))
    {
      safeChmod(file, 0o777);
      testExecutablePaths.push(file);
    }
  };

  addExecutable(path.join(buildDir, config, 'ne' + executableExtension));
  addExecutable(path.join(buildDir, 'ne' + executableExtension));
}

/*
async function runTests(testExecutablePaths)
{
  console.log('Running Tests');
  for (const testExecutablePath of testExecutablePaths)
  {
    const options = {
      cwd: path.dirname(testExecutablePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      err: printError,
      reject: false
    };
    await exec(testExecutablePath, [], options);
  }
}
*/

async function format(options)
{
  console.log('Formatting');
  await runEslint(options);
  // TODO(Trevor.Sundberg): Run cmake_format.
  const sourceFiles = gatherSourceFiles();
  if (options.tidy)
  {
    await runClangTidy(options, sourceFiles);
  }
  await runClangFormat(options, sourceFiles);
  await runWelderFormat(options, sourceFiles);
  // TODO(Trevor.Sundberg): Run cppcheck.
  // TODO(Trevor.Sundberg): Run cpplint.'
  //await runDoxygen();
  // TODO(Trevor.Sundberg): Run moxygen.
  console.log('Formatted');
}

async function build(options)
{
  console.log('Building');
  //const buildDir = await runCmake(options);
  const buildDir = await determineBuildDir(determineCmakeCombo(options));
  const testExecutablePaths = [];
  const configuration = options.configuration ? options.configuration : 'Release';
  await runBuild(buildDir, configuration, testExecutablePaths);
  //await runTests(testExecutablePaths);
  console.log('Built');
}

function getParsedArgs()
{
  const args = process.argv.splice(2);

  if (args.length === 0)
  {
    return ['build'];
  }

  const json = args.join(' ');

  if (json.startsWith('['))
  {
    return eval(json); // eslint-disable-line
  }

  // Assume the arguments are not in json format (just an array of strings).
  return args;
}

async function main()
{
  const commands = {
    format,
    runCmake,
    build,
  };

  const parsedArgs = getParsedArgs();
  for (let arg of parsedArgs)
  {
    console.log('--------------------------------------------------');
    let command;
    if (typeof arg === 'string')
    {
      command = commands[arg];
      arg = {
        name: arg
      };
    }
    else
    {
      command = commands[arg.name];
    }

    if (command)
    {
      await command(arg);
    }
    else
    {
      console.error(`Invalid command '${arg}'`);
    }
  }
}
main();
