require('./src/shared/question-matcher.js');
const { QuestionMatcher } = globalThis;

const bank = [{
  id: 'test',
  question: 'test question',
  answers: ['[hide=200]想要隐藏的内容[/hide]']
}];

const result1 = QuestionMatcher.lookup('test question', ['[hide=200]想要隐藏的内容[/hide]', '[hide=200 ]想要隐藏的内容[/hide]', '[hide=200]想要隐藏的内容[hide]'], bank);

console.log('Test 1 (exact visible strictly matching):', result1);

const ambiguousResult = QuestionMatcher.lookup('test question', ['[hide=200]想要隐藏的内容[/hide]', '[hide=200 ]想要隐藏的内容[/hide]', '[hide=200]想要隐藏的内容[hide]'], [{
  id: 'test',
  question: 'test question',
  answers: ['[hide=200]想要隐藏的内容[/hide]', '[hide=200 ]想要隐藏的内容[/hide]']
}]);

console.log('Test 2 (genuine ambiguous):', ambiguousResult);

