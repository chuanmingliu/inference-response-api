"""Rendering checks for the pinned Qwen template; these do not certify model quality."""
import hashlib
import json
import subprocess
from pathlib import Path
import unittest

from jinja2 import Environment

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'config/qwen3-responses.jinja').read_text()
TEMPLATE = Environment().from_string(SOURCE)


def render(messages, tools=None):
    return TEMPLATE.render(messages=messages, tools=tools, add_generation_prompt=True, enable_thinking=False)


class ResponsesTemplateTests(unittest.TestCase):
    def test_provenance_hash_matches_shipped_template(self):
        provenance = json.loads((ROOT / 'config/qwen3-template-provenance.json').read_text())
        self.assertEqual(hashlib.sha256(SOURCE.encode()).hexdigest(), provenance['template_sha256'])

    def test_all_instruction_and_conversation_roles_are_rendered_in_order(self):
        messages = [
            {'role': 'system', 'content': 'SYSTEM_ONE'},
            {'role': 'developer', 'content': 'DEVELOPER_ONE'},
            {'role': 'user', 'content': 'USER_ONE'},
            {'role': 'assistant', 'content': 'ASSISTANT_ONE'},
            {'role': 'system', 'content': 'SYSTEM_TWO'},
            {'role': 'developer', 'content': 'DEVELOPER_TWO'},
            {'role': 'user', 'content': 'USER_TWO'},
        ]
        rendered = render(messages)
        previous = -1
        for message in messages:
            marker = f"<|im_start|>{message['role']}\n{message['content']}"
            position = rendered.index(marker)
            self.assertGreater(position, previous)
            self.assertEqual(rendered.count(message['content']), 1)
            previous = position
        self.assertTrue(rendered.endswith('<|im_start|>assistant\n<think>\n\n</think>\n\n'))

    def test_upstream_template_would_drop_developer(self):
        original = SOURCE.replace('(message.role == "user") or (message.role == "developer")', '(message.role == "user")')
        provenance = json.loads((ROOT / 'config/qwen3-template-provenance.json').read_text())
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), provenance['original_template_sha256'])
        messages = [{'role': 'developer', 'content': 'KEEP_DEVELOPER'}, {'role': 'user', 'content': 'Hi'}]
        upstream = Environment().from_string(original).render(messages=messages, add_generation_prompt=True, enable_thinking=False)
        self.assertNotIn('KEEP_DEVELOPER', upstream)
        self.assertIn('<|im_start|>developer\nKEEP_DEVELOPER', render(messages))

    def test_pure_function_call_and_results_render_without_none_content(self):
        messages = [
            {'role': 'user', 'content': 'Get weather'},
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'call_1', 'type': 'function', 'function': {'name': 'weather', 'arguments': '{"city":"Paris"}'}},
            ]},
            {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'SUNNY'},
        ]
        rendered = render(messages, tools=[{'type': 'function', 'function': {'name': 'weather', 'parameters': {'type': 'object'}}}])
        self.assertIn('<tool_call>\n{"name": "weather", "arguments": {"city":"Paris"}}\n</tool_call>', rendered)
        self.assertIn('<tool_response>\nSUNNY\n</tool_response>', rendered)
        self.assertNotIn('None', rendered)

    def test_developer_first_with_tools_is_not_lost(self):
        rendered = render([{'role': 'developer', 'content': 'CALL_GUIDANCE'}, {'role': 'user', 'content': 'Hi'}], tools=[{'type': 'function', 'function': {'name': 'echo'}}])
        self.assertEqual(rendered.count('CALL_GUIDANCE'), 1)
        self.assertIn('<|im_start|>developer\nCALL_GUIDANCE', rendered)
        self.assertIn('<tools>', rendered)


class SglangFunctionGrammarTests(unittest.TestCase):
    """Exercise the adapter's actual grammar through XGrammar's CPU matcher."""
    @classmethod
    def setUpClass(cls):
        import xgrammar as xgr
        cls.xgr = xgr
        info = xgr.TokenizerInfo([bytes([i]) for i in range(128)] + [b'<eos>'], stop_token_ids=[128])
        cls.compiler = xgr.GrammarCompiler(info, max_threads=1)
        script = """
          import { compileChatRequest } from './lib/responses/engine.mjs';
          import { getRuntimeProfile } from './lib/responses/profiles.mjs';
          const tool = (name, strict) => ({type:'function',name,strict,parameters:{type:'object',properties:{city:{type:'string',enum:['Paris']}},required:['city'],additionalProperties:false}});
          const variants = {};
          for (const mode of ['auto','required','forced']) for (const parallel of [true,false]) for (const strict of [true,false]) {
            const request = {model:'test',input:[{type:'message',role:'user',content:[{type:'input_text',text:'Hi'}]}],tools:[tool('weather',strict),tool('other',strict)],tool_choice:mode==='forced'?{type:'function',name:'weather'}:mode,parallel_tool_calls:parallel,text:{format:{type:'text'}}};
            variants[[mode,parallel,strict].join('/')] = compileChatRequest(request,[],getRuntimeProfile('sglang-metal')).body.response_format;
          }
          process.stdout.write(JSON.stringify(variants));
        """
        cls.formats = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT, text=True))

    def accepts(self, mode, parallel, strict, content):
        key = f'{mode}/{str(parallel).lower()}/{str(strict).lower()}'
        compiled = self.compiler.compile_structural_tag(self.formats[key])
        matcher = self.xgr.GrammarMatcher(compiled)
        return matcher.accept_string(content) and matcher.is_completed()

    @staticmethod
    def call(name='weather', city='Paris'):
        return '<tool_call>\n' + json.dumps({'name': name, 'arguments': {'city': city}}, separators=(',', ':')) + '\n</tool_call>'

    def test_strict_arguments_are_constrained_in_every_mode(self):
        for mode in ['auto', 'required', 'forced']:
            with self.subTest(mode=mode):
                self.assertTrue(self.accepts(mode, False, True, self.call()))
                self.assertFalse(self.accepts(mode, False, True, self.call(city='London')))

    def test_nonstrict_arguments_are_not_constrained_to_declared_schema(self):
        for mode in ['auto', 'required', 'forced']:
            with self.subTest(mode=mode):
                self.assertTrue(self.accepts(mode, False, False, self.call(city='London')))

    def test_parallel_false_excludes_second_call_in_every_mode(self):
        twice = self.call() + '\n' + self.call()
        for mode in ['auto', 'required', 'forced']:
            with self.subTest(mode=mode):
                self.assertFalse(self.accepts(mode, False, True, twice))
        self.assertTrue(self.accepts('auto', True, True, twice))
        self.assertTrue(self.accepts('required', True, True, twice))

    def test_forced_choice_excludes_other_available_function(self):
        self.assertFalse(self.accepts('forced', True, True, self.call(name='other')))
        self.assertTrue(self.accepts('required', True, True, self.call(name='other')))

    def test_required_choice_rejects_prose_while_auto_allows_it(self):
        self.assertTrue(self.accepts('auto', False, True, 'Hello'))
        self.assertFalse(self.accepts('required', False, True, 'Hello'))
        self.assertFalse(self.accepts('forced', False, True, 'Hello'))


if __name__ == '__main__':
    unittest.main()
