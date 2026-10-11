/**
 * T3-CUSTOM(expbkt3): turns a t3_answer call into the answers a question
 * request accepts.
 *
 * Agents name options the way people read them, by number or label; the
 * request wants each question's option value (the label when it has none),
 * keyed by question id, as the web composer sends it
 * (`resolvePendingUserInputAnswer`). A request that resumes the agent with a
 * message, and a question the agent asked while it kept working, accept only
 * text, so several choices are joined into one line there.
 */
import * as Result from "effect/Result";

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
  readonly value?: string | undefined;
}

export interface QuestionView {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<QuestionOption>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly required?: boolean | undefined;
}

export type ChoiceInput = number | string | ReadonlyArray<number | string>;

export interface AnswerInput {
  readonly choice?: ChoiceInput | undefined;
  readonly text?: string | undefined;
  readonly answers?:
    | ReadonlyArray<{
        readonly question: number | string;
        readonly choice?: ChoiceInput | undefined;
        readonly text?: string | undefined;
      }>
    | undefined;
}

export type QuestionAnswers = Record<string, string | ReadonlyArray<string>>;

const optionValue = (option: QuestionOption) => option.value ?? option.label;

const describeOptions = (question: QuestionView) =>
  question.options.map((option, index) => `${index + 1}. ${option.label}`).join("; ");

/** One option, by its 1-based number, its label or its value. */
const resolveOption = (
  question: QuestionView,
  choice: number | string,
): Result.Result<string, string> => {
  if (typeof choice === "number") {
    const option = question.options[choice - 1];
    return option === undefined
      ? Result.fail(
          `Question "${question.header}" has no option ${choice}. Its options are: ${describeOptions(question)}.`,
        )
      : Result.succeed(optionValue(option));
  }
  const wanted = choice.trim().toLowerCase();
  if (/^\d+$/.test(wanted)) return resolveOption(question, Number(wanted));
  const option = question.options.find(
    (candidate) =>
      candidate.label.trim().toLowerCase() === wanted ||
      optionValue(candidate).trim().toLowerCase() === wanted,
  );
  return option === undefined
    ? Result.fail(
        `"${choice}" is not an option of question "${question.header}". Its options are: ${describeOptions(question)}. Pass text for your own answer.`,
      )
    : Result.succeed(optionValue(option));
};

const answerOne = (
  question: QuestionView,
  input: { readonly choice?: ChoiceInput | undefined; readonly text?: string | undefined },
  textOnly: boolean,
): Result.Result<string | ReadonlyArray<string> | undefined, string> => {
  const text = input.text?.trim();
  if (text !== undefined && text.length > 0) {
    if (question.allowCustomAnswer === false) {
      return Result.fail(
        `Question "${question.header}" accepts only its options: ${describeOptions(question)}. Pass choice.`,
      );
    }
    return Result.succeed(text);
  }
  if (input.choice === undefined) return Result.succeed(undefined);
  const choices: ReadonlyArray<number | string> =
    typeof input.choice === "object" ? input.choice : [input.choice];
  if (choices.length > 1 && question.multiSelect !== true) {
    return Result.fail(
      `Question "${question.header}" takes one option; you passed ${choices.length}.`,
    );
  }
  const values: Array<string> = [];
  for (const choice of choices) {
    const value = resolveOption(question, choice);
    if (Result.isFailure(value)) return Result.fail(value.failure);
    values.push(value.success);
  }
  if (values.length === 0) return Result.succeed(undefined);
  if (question.multiSelect === true && !textOnly) return Result.succeed(values);
  return Result.succeed(values.join(", "));
};

/** The question an `answers` entry names: its 1-based number or its id. */
const findQuestion = (questions: ReadonlyArray<QuestionView>, ref: number | string) =>
  typeof ref === "number"
    ? questions[ref - 1]
    : /^\d+$/.test(ref.trim())
      ? questions[Number(ref.trim()) - 1]
      : questions.find((question) => question.id === ref);

/**
 * The answers to send, or the reason the call cannot answer: an unknown
 * option, a missing answer to a required question, or a choice/text call on a
 * request that asks several questions.
 */
export function buildAnswers(
  questions: ReadonlyArray<QuestionView>,
  input: AnswerInput,
  textOnly: boolean,
): Result.Result<QuestionAnswers, string> {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  if (input.answers !== undefined && input.answers.length > 0) {
    for (const entry of input.answers) {
      const question = findQuestion(questions, entry.question);
      if (question === undefined) {
        return Result.fail(
          `This request has no question ${JSON.stringify(entry.question)}. Its questions are: ${questions
            .map((candidate, index) => `${index + 1}. ${candidate.header}`)
            .join("; ")}.`,
        );
      }
      const answer = answerOne(question, entry, textOnly);
      if (Result.isFailure(answer)) return Result.fail(answer.failure);
      if (answer.success !== undefined) answers[question.id] = answer.success;
    }
  } else if (input.choice !== undefined || input.text !== undefined) {
    const target = questions.length === 1 ? questions[0] : undefined;
    if (target === undefined) {
      return Result.fail(
        `This request asks ${questions.length} questions (${questions
          .map((question, index) => `${index + 1}. ${question.header}`)
          .join("; ")}). Pass answers with one entry per question.`,
      );
    }
    const answer = answerOne(target, input, textOnly);
    if (Result.isFailure(answer)) return Result.fail(answer.failure);
    if (answer.success !== undefined) answers[target.id] = answer.success;
  } else {
    return Result.fail("Pass choice, text or answers to answer a question.");
  }
  const missing = questions.filter(
    (question) => question.required !== false && answers[question.id] === undefined,
  );
  if (missing.length > 0) {
    return Result.fail(
      `Answer every required question. Missing: ${missing
        .map((question) => `"${question.header}"`)
        .join(", ")}.`,
    );
  }
  return Result.succeed(answers);
}
