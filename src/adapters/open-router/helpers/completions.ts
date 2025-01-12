import { Context } from "../../../types";
import { SuperOpenRouter } from "./open-router";
import OpenAI from "openai";

export interface CompletionsType {
  answer: string;
  groundTruths: string[];
}

export class OpenRouterCompletion extends SuperOpenRouter {
  constructor(client: OpenAI, context: Context) {
    super(client, context);
  }

  getModelMaxTokenLimit(model: string): number {
    const tokenLimits = new Map<string, number>([
      ["anthropic/claude-3.5-sonnet", 200000],
      ["google/gemini-2.0-flash-thinking-exp:free", 40000],
    ]);
    const tokenLimit = tokenLimits.get(model);
    if (!tokenLimit) {
      throw this.context.logger.error(`The token limits for configured model ${model} was not found`);
    }
    return tokenLimit;
  }

  getModelMaxOutputLimit(model: string): number {
    const tokenLimits = new Map<string, number>([
      ["anthropic/claude-3.5-sonnet", 4096],
      ["google/gemini-2.0-flash-thinking-exp:free", 8000],
    ]);
    const tokenLimit = tokenLimits.get(model);
    if (!tokenLimit) {
      throw this.context.logger.error(`The token limits for configured model ${model} was not found`);
    }
    return tokenLimit;
  }

  async createCompletion(model: string, localContext: string, groundTruths: string[], botName: string, maxTokens: number): Promise<CompletionsType> {
    const query = `Perform code review using the diff and spec and output a JSON format with key 'confidenceThreshold': (0-1) and reviewComment: <string>. A 0 indicates that the code review failed and 1 mean its passed and you should output the review comment to be "This pull request has passed the automated review, a reviewer will review this pull request shortly". YOU SHOULD ONLY OUTPUT RAW JSON DATA`;
    const sysMsg = [
      "You Must obey the following ground truths: ",
      JSON.stringify(groundTruths) + "\n",
      "You are tasked with assisting as a GitHub bot by generating a confidence threshold from 0-1 on whether you think the pull difference completes the issue specification/body based on provided chat history and similar responses, focusing on using available knowledge within the provided corpus, which may contain code, documentation, or incomplete information. Your role is to interpret and use this knowledge effectively to answer user questions.\n\nSteps\n1. Understand Context: Analyze the chat history and similar responses to grasp the issue requirements and pull request intent\n2. Extract Key Information: Identify crucial details from the corpus, even if incomplete, focusing on specifications and their alignment with the pull diff\n3. Evaluate Completeness: Assess how well the pull diff fulfills the issue specifications, using logical assumptions if needed to fill gaps\n4. Generate Confidence: Provide a confidence score (0-1) indicating how likely the pull diff satisfies the issue specification\n5. Generate Review Comment: Based on confidence: If 1, indicate PR passed review and will be reviewed shortly; If <1, provide specific needed changes\n6. Output Response: Return JSON: {confidenceThreshold: <value>, reviewComment: <string>}",
      `Your name is: ${botName}`,
      "\n",
      "Main Context (Provide additional precedence in terms of information): ",
      localContext,
    ].join("\n");

    this.context.logger.debug(`System message: ${sysMsg}`);

    const res = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: sysMsg,
        },
        {
          role: "user",
          content: query,
        },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "review_output",
          strict: true,
          schema: {
            type: "object",
            properties: {
              confidenceThreshold: {
                type: "number",
                description: "Confidence of the review between 0-1",
              },
              reviewComment: {
                type: "string",
                description: "The review comment for the pull request",
              },
            },
            required: ["confidenceThreshold", "reviewComment"],
            additionalProperties: false,
          },
        },
      },
    });

    if (!res.choices || res.choices.length === 0) {
      throw this.context.logger.error("Unexpected no response from LLM");
    }

    const answer = res.choices[0].message.content;
    if (!answer) {
      throw this.context.logger.error("Unexpected response format: Expected text block");
    }

    const inputTokens = res.usage?.prompt_tokens;
    const outputTokens = res.usage?.completion_tokens;

    if (inputTokens && outputTokens) {
      this.context.logger.info(`Number of tokens used: ${inputTokens + outputTokens}`);
    } else {
      this.context.logger.info(`LLM did not output usage statistics`);
    }

    return {
      answer,
      groundTruths,
    };
  }

  async createGroundTruthCompletion(context: Context, groundTruthSource: string, systemMsg: string): Promise<string | null> {
    const {
      config: { openRouterAiModel },
    } = context;

    const res = await this.client.chat.completions.create({
      model: openRouterAiModel,
      max_tokens: this.getModelMaxTokenLimit(openRouterAiModel),
      messages: [
        {
          role: "system",
          content: systemMsg,
        },
        {
          role: "user",
          content: groundTruthSource,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "ground_truths",
          strict: true,
          schema: {
            type: "array",
            items: {
              type: "string",
              description: "A ground truth statement",
            },
            minItems: 10,
            maxItems: 10,
          },
        },
      },
    });

    if (!res.choices || res.choices.length === 0) {
      throw this.context.logger.error("Unexpected no response from LLM");
    }

    const answer = res.choices[0].message.content;
    if (!answer) {
      throw this.context.logger.error("Unexpected response format: Expected text block");
    }

    return answer;
  }
}
