// MIT Licensed (see LICENSE.md).
#pragma once

namespace Zero
{
/// System Memory Information
struct ZeroShared MemoryInfo
{
  uint Reserve;
  uint Commit;
  uint Free;
};

namespace Os
{

// Sleep the current thread for ms milliseconds.
ZeroShared void Sleep(uint ms);

// Set the Timer Frequency (How often the OS checks threads for sleep, etc)
ZeroShared void SetTimerFrequency(uint ms);

// Get the user name for the current profile
ZeroShared String UserName();

// Get the computer name
ZeroShared String ComputerName();

// Get computer Mac Address of adapter 0
ZeroShared u64 GetMacAddress();

// Check if a debugger is attached
ZeroShared bool IsDebuggerAttached();

// Output a message to any attached debuggers
ZeroShared void DebuggerOutput(const char* message);

// Debug break (only if a debugger is attached)
ZeroShared bool DebugBreak();

// Attempts to enable memory leak checking (break on
ZeroShared void EnableMemoryLeakChecking(int breakOnAllocation = -1);

// When a diagnostic error occurs, this is the default response
ZeroShared bool ErrorProcessHandler(ErrorSignaler::ErrorData& errorData);

// Open the application with parameters.
ZeroShared bool ShellOpenApplication(StringParam file, StringParam parameters = String(), StringParam workingDirectory = String());

// On browser based platforms, we can't access the user's file-system so we need to download files instead.
ZeroShared bool SupportsDownloadingFiles();

// Open's a url in a browser or tab.
ZeroShared void OpenUrl(cstr url);

// Get the time in milliseconds for a double click.
ZeroShared unsigned int GetDoubleClickTimeMs();

// Get the memory status of the Os.
ZeroShared void GetMemoryStatus(MemoryInfo& memoryInfo);
} // namespace Os

// Generate a 64 bit unique Id. Uses system timer and mac
// address to generate the id.
ZeroShared u64 GenerateUniqueId64();

// Waits for expression to evaluate to true, checking approximately every
// pollPeriod (in milliseconds)
#define WaitUntil(expression, pollPeriod)                                                                              \
  do                                                                                                                   \
  {                                                                                                                    \
    while (!(expression))                                                                                              \
    {                                                                                                                  \
      Os::Sleep(pollPeriod);                                                                                           \
    }                                                                                                                  \
  } while (gConditionalFalseConstant)

} // namespace Zero
