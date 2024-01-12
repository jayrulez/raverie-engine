// MIT Licensed (see LICENSE.md).
namespace Raverie
{

DeclareEnum2(StreamTypes, Output, Input);
DeclareEnum6(StreamStatus, Uninitialized, Initialized, Started, Stopped, ApiProblem, DeviceProblem);

// This function type will be used to either request audio output data or to
// provide audio input data. It will be called on the audio device thread.
typedef void IOCallbackType(float* outputBuffer, float* inputBuffer, unsigned framesPerBuffer, void* data);

// Audio Input Output

class AudioInputOutput
{
public:
  AudioInputOutput();
  ~AudioInputOutput();

  // Initializes the underlying audio API
  StreamStatus::Enum InitializeAPI(Raverie::String* resultMessage);
  // Initializes the specified audio stream
  StreamStatus::Enum InitializeStream(StreamTypes::Enum whichStream, Raverie::String* resultMessage);
  // Starts the specified audio stream, which will use the provided callback
  // function to either request or provide audio data.
  StreamStatus::Enum StartStream(StreamTypes::Enum whichStream, Raverie::String* resultMessage, IOCallbackType* callback, void* callbackData);
  // Stops the specified audio stream
  StreamStatus::Enum StopStream(StreamTypes::Enum whichStream, Raverie::String* resultMessage);
  // Shuts down the underlying audio API
  void ShutDownAPI();
  // Returns the number of channels in the specified audio stream
  unsigned GetStreamChannels(StreamTypes::Enum whichStream);
  // Returns the sample rate of the specified audio stream
  unsigned GetStreamSampleRate(StreamTypes::Enum whichStream);
  // Used to calculate the size for the input and output ring buffers
  float GetBufferSizeMultiplier();

private:
  OsHandle PlatformData;
};

} // namespace Raverie
