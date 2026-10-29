import "server-only";

const BUCKET="finance-files";
function config(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error("Supabase environment variables are not configured.");return{url,key}}
function headers(type?:string){const{key}=config();const result:Record<string,string>={apikey:key};if(!key.startsWith("sb_secret_"))result.Authorization=`Bearer ${key}`;if(type)result["Content-Type"]=type;return result}
export async function uploadFinanceObject(path:string,file:File){const{url}=config(),response=await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`,{method:"POST",headers:headers(file.type),body:await file.arrayBuffer()});if(!response.ok)throw new Error(`Finance attachment upload failed (${response.status}).`)}
export async function signedFinanceObject(path:string){const{url}=config(),response=await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${path}`,{method:"POST",headers:headers("application/json"),body:JSON.stringify({expiresIn:60})});if(!response.ok)throw new Error(`Finance attachment access failed (${response.status}).`);const body=await response.json() as{signedURL:string};return body.signedURL.startsWith("http")?body.signedURL:`${url}/storage/v1${body.signedURL}`}
