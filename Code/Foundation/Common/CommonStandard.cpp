// MIT Licensed (see LICENSE.md).
#include "Precompiled.hpp"

namespace Raverie
{
void InitializeKeyboard();

void CommonLibrary::Initialize()
{
  Thread::MainThreadId = Thread::GetCurrentThreadId();

  // Start the memory system used for all systems and containers.
  Memory::Root::Initialize();

  WebRequest::Initialize();

  // Initialize platform socket library
  Raverie::Status socketLibraryInitStatus;
  Raverie::Socket::InitializeSocketLibrary(socketLibraryInitStatus);

  // Setup keyboard enumerations
  InitializeKeyboard();

  // This is printed to any log for debugging purposes.
  ZPrint("Paths:\n"
         "  Application: %s\n"
         "      Working: %s\n"
         "    Documents: %s\n"
         "        Local: %s\n"
         "    Temporary: %s\n",
         GetApplication().c_str(),
         GetWorkingDirectory().c_str(),
         GetUserDocumentsDirectory().c_str(),
         GetUserLocalDirectory().c_str(),
         GetTemporaryDirectory().c_str());
}

void CommonLibrary::Shutdown()
{
  WebRequest::Shutdown();

  // Uninitialize platform socket library
  Raverie::Status socketLibraryUninitStatus;
  Raverie::Socket::UninitializeSocketLibrary(socketLibraryUninitStatus);

  Memory::Shutdown();
}

} // namespace Raverie
