import VaultDetail from "@/components/vault/VaultDetail";
export default async function VaultItemPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <VaultDetail id={id} />; }
