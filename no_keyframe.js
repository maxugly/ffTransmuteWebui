let count = 0;
export function pict_type_func(args)
{
  if (count === 0) {
    count++;
    return "I";
  }
  count++;
  return "P";
}
