import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ReasoningEffort,
} from 'openai/resources';

export type OpenAIModel = string;

export const models = {
  gpt4o: 'gpt-4o',
  chatgpt4oLatest: 'chatgpt-4o-latest',
  gpt4Turbo: 'gpt-4-turbo',
  gpt4: 'gpt-4',
  gpt3Turbo: 'gpt-3.5-turbo-0125',
  gpt3_16k: 'gpt-3.5-turbo-16k',
  gpt4oMini: 'gpt-4o-mini',
  o1: 'o1',
  o1Mini: 'o1-mini',
  o3Mini: 'o3-mini',
  o1Pro: 'o1-pro',
  gpt45Preview: 'gpt-4.5-preview',
  gpt4_1: 'gpt-4.1',
  o4Mini: 'o4-mini',
  o3: 'o4',
  gpt5: 'gpt-5',
  gpt5_1: 'gpt-5.1',
  gpt5_2: 'gpt-5.2',
};

const oModelsWithoutInstructions: OpenAIModel[] = [
  models.o1Mini,
  models.o1,
  models.o3Mini,
  models.o4Mini,
  models.o3,
  models.gpt5,
  models.gpt5_1,
  models.gpt5_2,
];

const modelsWithoutStandardControls: OpenAIModel[] = [models.gpt5];

const oModelsWithAdjustableReasoningEffort: OpenAIModel[] = [
  models.o1,
  models.o3Mini,
  models.o1Pro,
  models.o4Mini,
  models.o3,
  models.gpt5,
  models.gpt5_1,
  models.gpt5_2,
];
const defaultInstructions = 'You are a helpful assistant.';

export const requestToGPT = async ({
  prompt,
  temperature,
  responseFormat,
  model,
  instructions,
  topP,
  reasoningEffort,
}: {
  prompt: string;
  temperature: number;
  responseFormat: 'text' | 'json_object';
  model: OpenAIModel;
  instructions?: string;
  topP?: number;
  reasoningEffort?: ReasoningEffort;
}): Promise<string> => {
  const openAi = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (!openAi.apiKey) {
    throw new Error('No API key found for OpenAI');
  }

  const retryDelay = 5000;
  let attemptCount = 0;

  if (oModelsWithoutInstructions.includes(model) && instructions) {
    prompt = `
      ${instructions}

      -------

      ${prompt}
    `;
  }

  const timeoutId = setTimeout(() => {
    throw new Error('OpenAI API request timed out');
  }, 90000);

  try {
    const messagesArray: ChatCompletionMessageParam[] = instructions
      ? [
          { role: 'system', content: instructions || defaultInstructions },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];

    const params: ChatCompletionCreateParamsNonStreaming = {
      model: model,
      messages: messagesArray,
      response_format: { type: responseFormat },
    };

    const shouldConfigureStandardControls =
      !oModelsWithoutInstructions.includes(model) && !modelsWithoutStandardControls.includes(model);

    if (shouldConfigureStandardControls) {
      params.top_p = topP || 1;
      params.presence_penalty = 0;
      params.frequency_penalty = 0;
    }

    if (!oModelsWithAdjustableReasoningEffort.includes(model)) {
      params.temperature = temperature;
    }

    if (reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    } else if (oModelsWithAdjustableReasoningEffort.includes(model)) {
      params.reasoning_effort = 'medium';
    }

    const response = await openAi.chat.completions.create(
      params as unknown as ChatCompletionCreateParamsNonStreaming,
    );

    if (!response.choices[0]?.message?.content) {
      throw new Error('No content in response');
    }

    const finalResponse = response.choices[0].message.content;

    if (finalResponse.trim().toLowerCase().replace('.', '') === "sorry i can't help you with that") {
      console.error('ChatGPT responded with a generic error');
      throw new Error('Error with OpenAI API');
    }

    clearTimeout(timeoutId);

    return finalResponse;
  } catch (error: any) {
    console.error('Error with OpenAI API:', error);

    if (attemptCount < 1) {
      console.error(`Retrying after ${retryDelay} milliseconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      attemptCount++;

      return requestToGPT({
        prompt,
        temperature,
        responseFormat,
        model,
        instructions,
        topP,
        reasoningEffort,
      });
    } else {
      console.error('Error with OpenAI after retry');
      throw new Error('Error with OpenAI API');
    }
  }
};
