export const streamResponse = async (
  // ... your existing parameters
) => {
  let streamStarted = false;
  let hasReceivedData = false;
  let wordBuffer: string[] = [];
  let isTyping = false;
  let streamEnded = false;
  let pendingPartialWord = ''; // 🆕 Store incomplete words between chunks

  const typeWords = async (words: string[], delay: number = 50) => {
    if (isTyping) return;
    isTyping = true;
    
    for (const word of words) {
      onchunk(word + ' ', '');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    isTyping = false;
  };

  const processWordBuffer = async () => {
    if (wordBuffer.length > 0 && !isTyping) {
      const batchSize = streamEnded ? wordBuffer.length : Math.min(wordBuffer.length, 8);
      const wordsToType = wordBuffer.splice(0, batchSize);
      await typeWords(wordsToType, streamEnded ? 20 : 50);
    }
  };

  // 🆕 Function to intelligently split text considering word boundaries
  const processChunkText = (chunkText: string) => {
    // Combine with any pending partial word from previous chunk
    const fullText = pendingPartialWord + chunkText;
    
    // Split into potential words
    const parts = fullText.split(/\s+/);
    
    // Check if the chunk ends with a complete word or partial word
    const endsWithSpace = chunkText.endsWith(' ') || chunkText.endsWith('\n') || chunkText.endsWith('\t');
    
    let wordsToAdd: string[] = [];
    
    if (endsWithSpace || streamEnded) {
      // Chunk ends with whitespace = all words are complete
      wordsToAdd = parts.filter(word => word.length > 0);
      pendingPartialWord = '';
    } else {
      // Chunk doesn't end with whitespace = last part might be incomplete
      if (parts.length > 1) {
        // Add all complete words except the last one
        wordsToAdd = parts.slice(0, -1).filter(word => word.length > 0);
        // Keep the last part as pending (might be incomplete)
        pendingPartialWord = parts[parts.length - 1] || '';
      } else {
        // Only one part and no ending space = it's all potentially incomplete
        pendingPartialWord = parts[0] || '';
      }
    }
    
    return wordsToAdd;
  };

  const bufferInterval = setInterval(processWordBuffer, streamEnded ? 50 : 100);

  const payload = // ... your existing payload

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      onStreamStart?.();
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    console.log('Connected to SSE stream...');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    if (!streamStarted) {
      streamStarted = true;
      console.log('Stream started');
      onStreamStart?.();
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('Stream ended');
        streamEnded = true;
        
        // 🆕 Handle any remaining partial word when stream ends
        if (pendingPartialWord.trim()) {
          console.log('Adding final partial word:', pendingPartialWord);
          wordBuffer.push(pendingPartialWord.trim());
          pendingPartialWord = '';
        }
        
        // Wait for all words to be typed before proceeding
        console.log('Waiting for typing to complete...', wordBuffer.length, 'words remaining');
        
        while (wordBuffer.length > 0 || isTyping) {
          await processWordBuffer();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('All words typed, proceeding with metadata...');
        clearInterval(bufferInterval);

        // ... your existing metadata handling code
        let metadataJson;
        let extractedData;
        let buttons;
        let source;

        try {
          const metadataResponse = await fetch(apiGwUrl + '/metadata', {
            method: "POST",
            headers,
            body: JSON.stringify({ ResponseId: newResponseId }),
          });

          if (!metadataResponse.ok) {
            throw new Error(`Metadata API request failed with status: ${metadataResponse.status}`);
          }

          metadataJson = await metadataResponse.json();
          const citations = JSON.parse(metadataJson.citations);
          buttons = JSON.parse(metadataJson.buttons || '[]') || [];

          if (buttons && buttons.length > 1) {
            storeButtonData(buttons, newResponseId);
          }

          source = metadataJson.source || 'crewmate';
          const firstThreeCitations = citations.slice(0, 5);
          extractedData = firstThreeCitations.map((citation: any) => ({
            Title: citation.document.title.slice(0, 35),
            ClickUri: citation.document.clickableUri,
            Text: citation.text,
          }));
        } catch (error) {
          console.error('Error during Metadata API request:', error);
        }

        if (!hasReceivedData) {
          onComplete("Apologies, I couldn't find an answer to your query. I am still learning!", extractedData || [], source ?? 'crewmate');
        } else {
          onComplete(extractedData || [], source ?? 'crewmate');
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() && line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            const data: SSEMessage = JSON.parse(jsonStr);

            if (data.text) {
              hasReceivedData = true;
              let sanitizedText = data.text.replace(/\*\*\*/g, '**');
              sanitizedText = sanitizedText.replace(/\n\n/g, '\n');
              
              console.log('Received text:', data.text);
              console.log('Pending partial word before processing:', pendingPartialWord);
              
              // 🆕 Use smart word boundary processing
              const wordsToAdd = processChunkText(sanitizedText);
              
              if (wordsToAdd.length > 0) {
                wordBuffer.push(...wordsToAdd);
                console.log(`Added ${wordsToAdd.length} words:`, wordsToAdd);
              }
              
              console.log('Pending partial word after processing:', pendingPartialWord);
              console.log(`Buffer now has ${wordBuffer.length} words`);
              
            } else {
              console.warn('Missing "text" field in SSE data:', data);
            }
          } catch (e) {
            console.error('Error parsing SSE data:', e);
            onError(e);
          }
        }
      }
    }
  } catch (error) {
    clearInterval(bufferInterval);
    onStreamStart?.();
    onchunk('Apologies, I couldn\'t find an answer to your query. I am still learning!', 'default');
    console.error('Stream error:', error);
  }
};

// 🆕 Example of how it handles your edge case:
// Chunk 1: "TIGE" (no ending space) -> pendingPartialWord = "TIGE"
// Chunk 2: "R welcome" (ends with space) -> 
//   fullText = "TIGE" + "R welcome" = "TIGER welcome"
//   wordsToAdd = ["TIGER", "welcome"]
//   pendingPartialWord = ""
